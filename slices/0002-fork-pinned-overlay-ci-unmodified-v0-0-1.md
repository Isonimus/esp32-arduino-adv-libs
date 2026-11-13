---
id: '0002'
title: "Fork upstream builder at pinned commit, add overlay and CI, ship unmodified v0.0.1"
type: slice
status: accepted
date: 2026-11-13
supersedes: []
superseded_by: []
---

## Goal

Prove the thin-overlay pipeline (ADR-0001) end to end before any patch exists: pin
`espressif/esp32-arduino-lib-builder` at `idf-release_v5.5` / commit `e68e301`, build
`esp32` and `esp32s3` inside the digest-pinned builder image, and publish `v0.0.1` as an
`adv-esp32-arduino-libs-...zip` that is a byte-shape drop-in for the Bruce blob the two
consumers pin today
(`bmorcelli/.../bruce_esp32-arduino-libs-20251205-131242.zip`). No patches are applied in
this release: its whole job is to show the pipeline produces a replaceable artifact and to
establish the baseline the patch stack later builds on. INIT.md names this milestone
"slice-0001"; under the shared id space (ADR-0001, stele:ADR-0002) its id is 0002 because
ADR-0001 holds 0001.

## Definition of Done

- **Scenario A: drop-in shape parity**
  - **Given** the pinned upstream at commit `e68e301` with an empty patch stack
  - **When** CI builds `esp32` and `esp32s3` and packages the release zip
  - **Then** the zip's internal layout (top-level entries and per-chip subtree roots)
    matches the committed reference layout derived from the Bruce blob, so a consumer's
    one-line `platform_packages` URL swap resolves to the same package shape

- **Scenario B: all enabled chips or the release fails (invariant 4)**
  - **Given** the enabled chip set `{esp32, esp32s3}`
  - **When** any single chip build fails
  - **Then** the release job fails and publishes no artifact (no partial release)

- **Scenario C: five-pin provenance manifest (invariant 5)**
  - **Given** a tagged `v0.0.1` build
  - **When** the GitHub Release is published
  - **Then** it carries the zip, the zip's SHA-256, and a manifest recording all five
    pins: upstream builder commit, resolved IDF commit, resolved Arduino-core commit,
    patch-stack content hash (the empty-stack sentinel), and the builder Docker image
    digest

- **Scenario D: empty baseline stack**
  - **Given** this `v0.0.1` release
  - **When** the patch stack is inspected
  - **Then** `patches/` is empty and the manifest's patch-stack hash is the documented
    empty-stack sentinel, establishing the unpatched baseline

## Design

Thin overlay (ADR-0001 section 2). This repo stays our-delta-only; the heavy build is
upstream's and runs in CI, not in this session (an IDF build is multi-GB and hour-plus per
chip, ADR-0001 Context).

**What upstream code is reused, verbatim or near so (measured from the pinned tree):**

- `build.sh -e -t <target>` drives the per-chip IDF + Arduino-core build; `-e` is its own
  exit-on-error, which satisfies fail-loud without a wrapper. It already applies
  `patches/*` and reads `configs/defconfig.*`: those are the seams later slices (the patch
  stack, the sdkconfig overlays) plug into, so the overlay adds nothing upstream does not
  already invoke.
- `tools/archive-build.sh` / the `combine-artifacts` logic in `push.yml` assemble the
  per-chip output into the `<chip>/...`-rooted tree that is the package payload.
- `tools/config.sh` and `archive-build.sh` resolve `IDF_COMMIT` / branch from the
  checked-out tree, so the manifest reads the real commits rather than the stale
  `config.sh` default (`IDF_BRANCH=release/v5.3` even at the v5.5 tag, measured
  2026-11-13: a default we must not trust, the reason the manifest reads the resolved tree
  instead).
- `tools/docker/Dockerfile` is the reproducible build environment; its published image is
  pinned by digest (ADR-0001 pin #5).

**What is deliberately NOT reused, and why:**

- Upstream `push.yml` builds on a floating `ubuntu-latest` with `prepare-ci.sh` installing
  deps live. That drifts and defeats byte-reproducibility (ADR-0001 section 6), so our
  `release.yml` instead builds inside the digest-pinned builder image.
- Upstream's full chip matrix (`esp32..esp32p4`) is narrowed to `{esp32, esp32s3}`: the
  only chips the two consumers run today (ADR-0001 section 5). Adding a chip is a later,
  consumer-driven change.
- Upstream ships a `.tar.gz`; the consumers pin a `.zip`, so we repackage the combined
  tree as `adv-esp32-arduino-libs-<IDF_TAG>-<YYYYMMDD>-<SHORTSHA>.zip` (ADR-0001 section 5).

**New code this slice adds (the overlay):**

- `UPSTREAM.lock`: the committed pins (upstream builder commit, builder image digest, the
  enabled chip list). The build reads this rather than a floating ref.
- `scripts/build.mjs` (or a thin shell equivalent): clone upstream at the locked commit,
  apply the (empty) patch stack and (empty) sdkconfig overlay, invoke `build.sh` per chip
  inside the pinned image, assemble and repackage the `.zip`, and emit the five-pin
  manifest + SHA-256.
- `.github/workflows/release.yml`: the matrix build meeting the ADR-0001 section 6 gate
  contract (push = build-only all chips, fail whole on any; tag `v*` = publish Release
  with zip + SHA-256 + manifest).
- `scripts/0002-verify.mjs`: the shape-parity check (see Verification).
- `README.md`: how a consumer pins a release, and the provenance story.

**Reference-layout probe.** The reference the parity check compares against is measured
once by `scripts/bruce-blob-shape-probe.mjs`: it downloads the Bruce blob, records its
top-level layout, and that measured layout is committed as the reference manifest and
quoted in this slice's `## As built`. Design decisions cite data, not estimates
(CLAUDE.md section 3): the parity claim rests on the actual blob, not on an assumption
about its shape.

## Verification

- **Scenario A** proof: `scripts/0002-verify.mjs`, wired into `package.json` as
  `verify:shape`. It takes a built zip, asserts its top-level entries and per-chip subtree
  roots equal the committed reference layout (from the Bruce-blob probe), and exits nonzero
  on any mismatch or error. It also writes the observed-vs-expected layout diff as an
  artifact for human review. Runs in `release.yml` after the build job (the unattended
  error-gate half, ADR-0001 / repo rule 3).
- **Scenario B** proof: the `release.yml` matrix (`fail-fast: false` so every chip is
  attempted and reported) plus a publish gate that requires every enabled chip's artifact
  present; a missing chip fails the job before any Release is created.
- **Scenario C** proof: a manifest-assert step in `release.yml` that fails the release
  unless the manifest carries all five pins non-empty, plus the SHA-256 of the published
  zip; `scripts/0002-verify.mjs` additionally asserts the manifest schema on the built
  artifact.
- **Scenario D** proof: `scripts/0002-verify.mjs` asserts `patches/` is empty and the
  manifest's patch-stack hash equals the documented empty-stack sentinel for this release.

The hour-plus Docker build itself is the CI job, not something the verify script re-runs;
the verify script checks the job's output artifact, fast and unattended, and fails loud if
the artifact is absent rather than skipping.

## As built

_Filled at merge (the freeze step): the measured Bruce-blob reference layout, the resolved
IDF and Arduino-core commits of the v0.0.1 build, the builder image digest, and
confirmation that each scenario above was met or the deviation recorded._

## Amendment - 2026-11-13: builder image strategy resolved to build-our-own

The Design above wrote "its published image is pinned by digest", which read either way:
pin upstream's published `espressif/esp32-arduino-lib-builder` image, or build our own from
the pinned `tools/docker/Dockerfile`. During implementation this was put to the operator and
resolved to **build our own, lean**: `scripts/build.mjs image` builds the image from the
pinned Dockerfile with its `FROM ubuntu:22.04` rewritten to a pinned digest (recorded in
`UPSTREAM.lock`), and pin #5 is that built image's ID.

The published-image alternative was rejected: its pin would point at a Docker Hub digest we
did not build, whose tag naming (`release-v5.5`) does not map to our commit and whose
retention is upstream's call, which weakens the one provenance guarantee this repo exists to
give. The measured mitigating fact is that IDF/Arduino determinism comes from pins #2/#3
(resolved commits plus the install scripts), so the image mainly pins the OS/apt layer: the
cost of building our own is a short, cacheable apt layer per run, not the toolchain.

Scope note (from the slice-0002 adversarial pass): pin #5 as built is an **attestation** of the
image a release ran in, not yet a from-scratch reconstruction input, because the Dockerfile's
apt/pip layers are unpinned and a rebuild yields a different image ID. Freezing those layers is
part of the deferred reproducibility work on the LEDGER; building our own image rather than
trusting a Docker Hub tag is what makes that future hardening ours to do.
