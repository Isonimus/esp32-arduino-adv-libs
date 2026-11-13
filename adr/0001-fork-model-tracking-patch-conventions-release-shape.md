---
id: '0001'
title: "Fork model, upstream tracking, patch-stack conventions, and release artifact shape"
type: architecture
status: accepted
date: 2026-11-13
supersedes: []
superseded_by: []
---

## Context

This repo owns a patched ESP-IDF + Arduino-core precompiled libraries build. Its purpose
is to ship a drop-in replacement for the third-party precompiled blob that two sibling
authorized-pentest firmwares pull today, so both can retire that dependency:

- `adversary` (ESP32-S3 Cardputer, ESP32-PICO M5StickC Plus2), and
- `esp32-wifi-sapper` (ESP32-S3 and classic ESP32, PSRAM and no-PSRAM legs).

Both pin the same blob today: a release of `bmorcelli/esp32-arduino-lib-builder` (the Bruce
project's fork of the upstream Espressif builder). Owning the build buys four payoffs that
each already cost a workaround in a consumer repo: setting sdkconfig flags the blob fixes
shut (`esp32-wifi-sapper:ADR-0080`), baking in the weak-deauth symbol so the objcopy
post-hook retires (`adversary:ADR-0027`, `adversary:ADR-0029`), auditable RF-stack
provenance for a red-team appliance, and control over opaque internals that have already
cost three ADRs in two weeks (`adversary:ADR-0135`, `adversary:ADR-0136`,
`adversary:ADR-0137`, `adversary:ADR-0153`).

The upstream builder is the thing we fork. Measured on 2026-11-13 with
`git ls-remote --tags`: `espressif/esp32-arduino-lib-builder` tag `idf-release_v5.5`
resolves to commit `e68e30112ffad75e96535408dfe25bff6d2f26fb`.

Two structural questions have real tradeoffs rather than a single right answer, so both
were put to the operator and decided on 2026-11-13:

1. How this repo carries upstream: vendor the whole builder tree, vendor a slice of it, or
   keep a thin overlay that fetches a pinned upstream at build time.
2. When the patch stack rebases onto a newer upstream / IDF: proactively per upstream
   release, or pull-based on a consumer need.

This ADR records the fork point, those two decisions, the patch-stack conventions, and the
release artifact contract. It fixes contracts; the Docker build, the CI workflow, and the
manifest generator are built by later slices and must meet the contracts fixed here.

## Decision

### 1. Fork point and provenance anchor

Fork `espressif/esp32-arduino-lib-builder` (upstream, not Bruce's fork), pinned at tag
`idf-release_v5.5`, commit `e68e30112ffad75e96535408dfe25bff6d2f26fb`. The pin is recorded
in a committed lockfile so the build reads it rather than a floating ref. The resolved IDF
commit, Arduino-core commit, and Docker image digest that the pinned builder produces are
captured in the release manifest (section 5), measured at build time, never guessed.

### 2. Fork model: thin overlay

This repo holds only our delta: the patch stack, sdkconfig overlays, build orchestration,
CI, and the method docs. The build clones upstream at the pinned commit, applies the
ordered patch stack, and builds. We do not vendor the upstream tree.

Reasoning the rejected alternative was weaker: vendoring the whole tree adds no provenance
that an immutable commit SHA does not already give, so it does not serve payoff #3 (the
manifest and the pin do that). What it does add is cost: our reviewable delta disappears
into a multi-thousand-file tree, and every upstream bump becomes a tree-wide rebase instead
of a one-line pin change. The one thing vendoring buys, survival of upstream deletion, is
covered more cheaply by the immutable SHA pin plus an optional mirror, and a vanished
upstream is a recoverable contingency (any clone or the built Docker layer still has the
sources), not a daily tax. The hybrid (vendor only the builder scripts) was rejected for
splitting provenance across two surfaces with no clean line on what to vendor.

### 3. Upstream tracking: pull-based

Pin and hold. The upstream / IDF / Arduino-core pin is bumped only when a consumer needs a
newer version or a security fix requires it, never to chase an upstream release tag. Each
bump is its own ADR + slice that re-verifies the whole patch stack still applies and every
enabled chip still builds. This spends the upgrade-treadmill cost only when a payoff demands
it, consistent with the deferral discipline that gated this initiative until its payoff pile
accumulated.

### 4. Patch-stack conventions

- **One concern per patch.** Patches are review-shaped, not commit-shaped. Combining two
  concerns into one patch refuses to answer "which change broke the link" and is forbidden.
- **Numbered, ordered, applied in filename order.** `patches/NNNN-<kebab-name>.patch`,
  produced as `git format-patch`-style diffs against the IDF or Arduino-core source tree.
- **Each patch header cites its consuming ADR** (`adversary:ADR-NNNN` or
  `esp32-wifi-sapper:ADR-NNNN`) with a short rationale. The doc linter cannot resolve
  cross-repo citations (`stele:ADR-0009`); the convention is kept so a human reviewer can
  trace every patch to the decision that demanded it.
- **A patch is a reasoned source change, never a post-build binary rewrite.** Post-build
  rewrites (the objcopy post-hook this repo retires) are the problem, not the solution.
- **An sdkconfig change is an overlay file** under `sdkconfig/` where the builder supports
  one; a flag reachable only by editing source is a source patch.
- **The patch-stack content hash** (a hash over the ordered patch files) is part of the
  release manifest, so a release names exactly which stack produced it.

### 5. Release artifact shape

- One zip per release, named `adv-esp32-arduino-libs-<IDF_TAG>-<YYYYMMDD>-<SHORTSHA>.zip`.
- Internal layout matches what the consumers already expect
  (`framework-arduinoespressif32-libs/<chip>/...`), so a single `platformio.ini` URL swap
  rebinds a consumer with no other change.
- Chip set is `esp32` and `esp32s3` at minimum (both consumers today). Every enabled chip
  builds and ships in every release; a per-chip build failure fails the whole release
  (consumer parity: a release that compiles only one chip ships nobody).
- Each GitHub Release carries the zip, a SHA-256 attestation of the zip, and a reproducible
  build manifest recording all five pins: (a) upstream builder commit, (b) resolved IDF
  commit, (c) resolved Arduino-core commit, (d) patch-stack content hash, (e) Docker image
  digest. A release that cannot be rebuilt from those inputs has no provenance guarantee and
  defeats payoff #3.

### 6. CI gate contract

The CI workflow is built by a later slice; this ADR fixes the contract it must satisfy:

- On push touching `patches/`, `sdkconfig/`, or `scripts/`: rebuild all enabled chips, fail
  on any chip failing, publish no artifact.
- On tag `v*`: rebuild all chips, publish the GitHub Release with zip + SHA-256 + manifest.
- Reproducibility: a tag rebuild compares byte-for-byte against the prior build of the same
  tag; divergence fails the release.

### 7. Release sequence

Each step is its own ADR + slice in this repo:

- `v0.0.1`: unmodified build, no patches. Proves the pipeline and drop-in replaceability
  before any patch exists (slice-0001).
- `v0.1.0`: patch #1 `weak-ieee80211_raw_frame_sanity_check` (slice-0002).
- `v0.2.0`: patch #2 `sdkconfig-spiram-bss-ext` (slice-0003).
- `v0.3.0`: patch #3 `wifi_ap_record-pmf-bits` (slice-0004).
- Patches #4 (`supplicant-pmkid-path`) and #5 (`panic-hook-wrap-chain`) follow when their
  consumer ADRs are ready to drive them.

## Consequences

- **Standing invariants created** (added to `CLAUDE.md` section 4 in this same commit):
  one concern per patch; each patch header cites its consuming ADR; no post-build binary
  rewrite ships in a release; every tagged release builds and publishes all enabled chips or
  fails whole; every release is reconstructable from the five recorded pins plus the patch
  stack. The last two are enforceable only once the build and CI exist, so they ship as
  `pending (LEDGER)` today and become `verified_by` the CI workflow when slice-0001 lands it.
- **`INIT.md` is retired as slice-0001 lands.** Its content moves into `README.md`, this
  ADR, and later ADRs under the single-writer rule; it is deleted, not left to rot.
- **Upstream-reachability risk is accepted and deferred.** An optional source mirror is not
  built until a need appears; the debt sits on the LEDGER so it is not mistaken for an
  oversight.
- **Patches #4 and #5 are deferred** to their own consumer-driven ADRs, tracked on the
  LEDGER.
- The Docker build glue, the manifest generator, and the CI workflow are deliberately left
  to slices; this ADR fixes only the contracts they must meet, so none of its claims go
  stale when an implementation detail changes.
