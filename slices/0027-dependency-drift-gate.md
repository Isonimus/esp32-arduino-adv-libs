---
id: '0027'
title: "Capture each chip's resolved dependencies.lock and gate a rebuild against it (resolved-dependency drift gate)"
type: slice
status: accepted
date: 2026-11-15
supersedes: []
superseded_by: []
---

## Goal

Deliver the achievable half of the reproducibility gate ADR-0026 re-scopes section 6 to, and close the
LEDGER `[bug]`: "Capture the build's generated `dependencies.lock` for full reproducibility." The component
manager resolves the transitive dependency tree (esp-dsp, esp-modbus, esp_modem, the kept arduino deps,
and the rest) at build time and writes `<chip>/dependencies.lock` into the artifact, but nothing pins or
captures it, so a rebuild could silently resolve a newer transitive component with no signal. This slice
commits each enabled chip's resolved lock as a snapshot under `reference/` and adds a CI gate that fails
the build, with a per-component diff, the moment a rebuild's resolved tree drifts from the snapshot. The
byte-for-byte artifact compare that section 6 first named is withdrawn (ADR-0026): the zip name and
manifest carry the build date, and the image apt/pip layers and the IDF/GCC build are not bit-pinned, so a
raw compare is unsatisfiable and a payload-byte-for-byte variant is disproportionate today.

## Definition of Done

- **Given** a built release zip whose `<chip>/dependencies.lock` matches the committed
  `reference/dependencies.lock.<chip>` snapshot for every enabled chip
- **When** `scripts/0027-verify.mjs` runs against the zip
- **Then** it passes, reporting the resolved component count per chip, and writes its findings to
  `.verify-out/0027-deps-lock.json`

- **Given** a built release zip in which a chip's resolved tree has drifted (a bumped transitive version,
  a re-packed component with a new `component_hash`, or an added/removed component)
- **When** `scripts/0027-verify.mjs` runs against the zip
- **Then** it exits non-zero, naming each drift as a human-readable diff line and the re-bless command,
  rather than passing silently

- **Given** an enabled chip with no committed snapshot at `reference/dependencies.lock.<chip>`
- **When** `scripts/0027-verify.mjs` runs
- **Then** it fails loud naming the missing snapshot (a drift gate with no baseline is not a gate), rather
  than treating "no snapshot" as a pass

## Design

Measured basis and the decision are in ADR-0026. What this slice builds:

- **The snapshot.** Each enabled chip's resolved `dependencies.lock`, committed verbatim as
  `reference/dependencies.lock.<chip>` (next to the existing `reference/bruce-blob-layout.json`). It is
  the component manager's own output, never hand-authored. `reference/` is outside the doc linter's read
  scope (`scripts/lint-docs.mjs` `READ_SCOPE`), so the snapshot is committed data, not a linted document.
- **The pure projection + diff** (`scripts/lib/dependencies-lock.mjs`, beside the existing
  `checkDependenciesLock`). `projectDependenciesLock` parses the component-manager YAML down to the
  provenance-meaningful set: each resolved component's `version` and `component_hash`, the `target`, and
  the sorted `direct_dependencies`. Indentation is the parse key, because it is what separates a
  component's own resolved `version:` (4 spaces) from a requirement range's `version:` (6 spaces, under a
  `- name:` item in the component's nested `dependencies:`): the lock carries both, and reading the range
  as the pin would be a silent wrong answer. `manifest_hash`, requirement ranges and source URLs are
  deliberately excluded (inputs/fingerprints, not resolution outputs); excluding `manifest_hash` in
  particular keeps the gate from firing on any manifest edit that does not actually change resolution.
  `diffDependencyLocks` names every drift (changed target, added/removed component, changed version or
  content hash, changed direct-dependency set) and returns `[]` on a match. Both are pure and fail loud on
  a structurally malformed lock (no `target:`, an empty `dependencies:` block, or a component with no
  resolved version), so a truncated lock cannot project to an empty tree that matches another empty tree.
- **The verify.** `scripts/0027-verify.mjs` reads the enabled chips from `UPSTREAM.lock`, extracts each
  `<chip>/dependencies.lock` from the built zip, projects both it and the committed snapshot through the
  same function, diffs, and exit-gates. On drift it prints the diff and the exact re-bless command
  (`unzip -p <zip> <chip>/dependencies.lock > reference/dependencies.lock.<chip>`). It fails loud on a
  missing snapshot. Findings are written to `.verify-out/0027-deps-lock.json` for review. Mirrors the
  shape of `scripts/0012-verify.mjs`, the other gate over the same lock file.
- **Standing invariant 13** (`CLAUDE.md` section 4): every tagged release's resolved
  `<chip>/dependencies.lock` matches the committed `reference/` snapshot for every enabled chip,
  `verified_by: scripts/0027-verify.mjs`.
- **CI wiring.** `verify:deps-lock` in `package.json` (R11), and a step in the `release.yml` `package`
  job alongside the other post-build verifies. The `package` job's `release-bundle` upload is moved
  **above** the verify steps so the built artifact is available for inspection when a gate fails (and so
  the drift snapshot is capturable from a failing bootstrap run); the tag-gated publish step stays last
  and still runs only if every verify passed, so nothing is published on a failed gate.

**Existing code considered.** The lock is already read by `scripts/0012-verify.mjs` via
`checkDependenciesLock` (a *policy* check: removed components absent, kept components present). This slice
does not reuse that function (different question: exact resolved tree vs. a present/absent policy) but
puts its new functions in the same `dependencies-lock.mjs` lib for cohesion, and keeps both gates: 0012 is
driven by `UPSTREAM.lock`'s removed/kept sets (the slim policy), 0027 by the full committed snapshot (the
resolved truth). The `reference/` directory and the per-chip zip-subtree extraction (`unzip -p`) are both
reused patterns. A raw-byte file compare was considered and rejected: it would fire on cosmetic
YAML-emitter churn, training re-blesses on noise, where the semantic projection fires only on a real
resolution change.

## Verification

- **Unit** (`test/dependency-drift.test.mjs`, run by `npm test`): `projectDependenciesLock` captures the
  resolved version and hash (never the nested requirement range), sheds quoted scalars, and fails loud on
  a lock with no target / no components / a versionless component; `diffDependencyLocks` reports no drift
  on an identical projection and catches a bumped version, a re-packed component (same version, new hash),
  an added and a removed component (with the direct-dependency change), and a target mix-up. Each
  assertion fails before the functions exist and passes after. Covers Definition-of-Done scenarios 1 and 2
  at the projection/diff level. The parser was additionally run against the real v0.0.2 esp32 and esp32s3
  locks during development (10 and 13 resolved components, including `lan867x`'s `targets:` list and the
  esp32s3 esp-sr stack) and projected both correctly.
- **Post-build integration** (`scripts/0027-verify.mjs`, wired as `verify:deps-lock` in `package.json`,
  R11): given the built zip, extracts each chip's lock, projects, diffs against the committed snapshot, and
  exit-gates. Its error-gate half runs in CI in the `package` job. The missing-snapshot fail-loud is
  Definition-of-Done scenario 3. The fail-before/pass-after against a real drifted artifact is recorded in
  `## As built`.
- **CI build** (`release.yml`): both chips building green and the gate passing on the real built artifact
  is proven by the matrix build the overlay-touching push triggers; recorded in `## As built`.
- **Snapshot bootstrap** (recorded in `## As built`, like slice-0022's drop-in re-trial): the committed
  snapshot is captured from the first green build on the current lock, because v0.0.2's lock predates the
  esp-sr removal (ADR-0017) and is not a valid baseline for `main`. This needs a CI build, so it is a
  measured step in `## As built`, not a thing assertable before the first build.

## As built

Filled in at merge, in past tense, confirming each Definition-of-Done scenario was met or recording the
deviation. The snapshot capture, the CI build, and the verify fail-before/pass-after results are recorded
in amendments below at merge.

## Amendment: 2026-11-15 Bootstrap build, snapshot captured, gate fail-before/pass-after

Shipped as designed. CI run 43703394331 (workflow_dispatch on `feat/dependency-drift-gate`, commit
`efae0cc`) built both chips green (prep, pins, image, chips(esp32), chips(esp32s3) all success) and
uploaded the `release-bundle` artifact (`adv-esp32-arduino-libs-v5.5-20261115-e68e301.zip`) in the
`package` job before the verify steps, as the reorder intended. On that run the drift gate FAILED at its
step because no snapshot was committed yet: `scripts/0027-verify.mjs` reported `FAIL esp32: no committed
snapshot ...` and `FAIL esp32s3: no committed snapshot ...` (Definition-of-Done scenario 3, and the
per-chip reporting confirmed, both chips named in one run), and the job went red there while every earlier
verify passed.

The two committed snapshots were captured verbatim from that build's zip:
`reference/dependencies.lock.esp32` (10 resolved components) and `reference/dependencies.lock.esp32s3` (8
resolved components). esp32s3 carries no esp-sr / esp-dl / dl_fft / cjson / esp_new_jpeg: the esp-sr stack
removed by ADR-0017. This is why the v0.0.2 artifact's lock could not seed the snapshot (its esp32s3 tree
still had esp-sr), and why the baseline had to come from a build on the current lock.

The same gate then PASSED locally against that identical CI-built zip once the snapshots were committed:
"ok esp32: 10 resolved component(s) match the committed snapshot", "ok esp32s3: 8 resolved component(s)
match the committed snapshot" (Definition-of-Done scenarios 1 and 2's pass path). Fail-before /
pass-after is therefore proven against the real artifact. The green-in-CI confirmation is the re-dispatched
build on this branch with the snapshots committed, recorded below.
