---
id: '0018'
title: "Remove esp-sr: strip the esp32s3 esp_sr feature, srmodels step, manifest entry and model subtree"
type: slice
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Goal

Remove `esp-sr`, the last unused managed component, finishing the slim ADR-0006 began and ADR-0011
continued. The two consumer firmwares link no speech-recognition API, yet the stock builder still
downloads esp-sr, builds its speech models, and ships a `srmodels.bin` blob and an `esp32s3/esp_sr/`
subtree. slice-0012 split esp-sr out because it is entangled with the builder's `esp_sr` *feature*
(`builds.json` + the `srmodels_bin` step in `build.sh` + `defconfig.esp_sr`), a heavier mechanism than
the manifest-only removals. This slice applies the ADR-0017 decision: drop the component from the
manifest, the `esp_sr` feature from the esp32s3 target, and esp-sr's `srmodels_bin` step from `build.sh`,
and teach Scenario A shape parity to subtract the removed `esp32s3/esp_sr/` subtree.

This closes the LEDGER `[feature]` esp-sr item (ADR-0006, ADR-0011) and narrows the `[bug]`
unpinned-`dependencies.lock` item (ADR-0005): its esp-sr clause is removed (a removed component needs no
pin), leaving only the transitive-tree capture open.

A measured consequence the ADR records: removing the `esp_sr` feature also drops
`configs/defconfig.esp_sr`, which had forced `CONFIG_ESPTOOLPY_FLASHSIZE_16MB` on esp32s3 (overriding
`defconfig.common`'s 4MB). esp32s3 falls back to the common 4MB default, matching esp32. This is a
deliberate divergence from the blob (which keeps esp-sr at 16MB), chosen because 4MB underestimates the
actual 8MB Cardputer flash (the safe direction) where 16MB overestimates it, and confirmed by a
Cardputer boot re-trial.

## Definition of Done

- **Given** `UPSTREAM.lock` with `espressif/esp-sr` in `removedComponents`, `removedBuildFeatures`
  keying `esp32s3` with `esp_sr`, and `removedChipSubtrees` keying `esp32s3` with `esp_sr/`
- **When** each enabled chip builds in CI
- **Then** both `esp32` and `esp32s3` build green: the esp32s3 build no longer runs `idf.py
  srmodels_bin` (whose target esp-sr's CMake registered), so removing the manifest entry does not break
  the build

- **Given** the built release artifact
- **When** `scripts/0018-verify.mjs` inspects it
- **Then** no `esp32s3/esp_sr/` entry is present (no `srmodels.bin`), and the `esp32s3/sdkconfig` carries
  `CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y` and not `CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y`, exiting non-zero
  otherwise

- **Given** the built release artifact
- **When** `scripts/0012-verify.mjs` inspects each chip's `dependencies.lock`
- **Then** `espressif/esp-sr` appears in neither chip's resolved tree, and the kept sentinels still do

- **Given** the slimmed artifact
- **When** `scripts/0002-verify.mjs` checks drop-in shape parity
- **Then** Scenario A passes: the `esp32s3` members equal the reference blob's minus the declared
  `removedChipSubtrees` (`esp_sr/`), and every other per-chip root is unchanged; a kept root going
  missing still fails

- **Given** a `removeBuildFeatures` or `stripEspSrModelStep` call whose target, feature or build-step
  block is absent
- **When** the overlay runs
- **Then** it fails loud naming what was absent, rather than silently no-op'ing

- **Given** the rebuilt esp32s3 libs (now 4MB, no esp_sr) flashed to a PSRAM-less StampS3 Cardputer
- **When** the board boots
- **Then** it reaches the firmware UI with no regression from the slice-0016 boot (the flash-size change
  to 4MB does not break boot), recorded in `## As built`

## Design

Measured basis and the full rationale (including the flash-size decision and why the manifest removal
forces the feature and step removals) are in ADR-0017. What this slice builds:

- **Manifest, reused mechanism.** `espressif/esp-sr` joins `removedComponents`; `applyOverlay` already
  rewrites `main/idf_component.yml` with `removeManagedComponents` (ADR-0006), and `0012-verify` already
  asserts removed components are absent from `dependencies.lock` (ADR-0011). No new code for this half.
- **`removeBuildFeatures` (new, host-side).** A pure parse/modify/serialize of `configs/builds.json`
  that drops a feature from a keyed target's `features` array, re-serialized tab-indented like upstream,
  failing loud if the target, its features array, or the feature is absent. Structural (by value), not
  text matching, so a reformat upstream cannot slip it.
- **`stripEspSrModelStep` (new, host-side).** Removes the esp32s3 `srmodels_bin` block from `build.sh`,
  anchored on the unique `if [ "$target" == "esp32s3" ]; then` guard and its immediate `srmodels_bin`
  call, through the matching 4-space `fi` (the nested `if [ -f ... ]` closes at a deeper indent, so the
  first `\n    fi\n` after the anchor is the outer close). Fails loud if the block is absent. Gated in
  `applyOverlay` on `removedBuildFeatures.esp32s3` including `esp_sr`, so one lock field drives both the
  `builds.json` edit and the `build.sh` edit.
- **Scenario A subtraction (new, in `0002-verify`).** `UPSTREAM.lock` gains `removedChipSubtrees`;
  `0002-verify` subtracts it from the reference member set per chip before the exact match, and fails
  loud if a declared removal is not actually in the reference. This keeps the "a kept root like `lib/`
  must be present" guard while allowing the deliberate `esp_sr/` drop.
- **`scripts/0018-verify.mjs` (new).** Reads `enabledChips` and `removedChipSubtrees` from the lock;
  asserts the built zip has no entry under each removed subtree and that `esp32s3/sdkconfig` reverted to
  4MB. Mirrors the wired, artifact-inspecting, exit-code-gating shape of `0012`/`0016-verify`.

**Existing code considered.** `removeManagedComponents` (ADR-0006) is reused verbatim for the manifest
half. The new `removeBuildFeatures` and `stripEspSrModelStep` sit beside the existing host-side rewrites
(`setBuilderCxxStandard`, `stripDefconfigSymbols`, `appendDefconfigLines`, `stripBuilderCxxDefine`) and
follow their pure, fail-loud contract; none of them edits `builds.json` or removes a `build.sh` block,
which is the gap. The `build.sh` handling in `applyOverlay` is refactored to read-once/write-once so the
srmodels strip composes with the existing `pinBuildSources` and arduino-manifest-strip rewrites rather
than duplicating the read/write. The verify follows `scripts/0012-verify.mjs` and `scripts/0016-verify.mjs`.

## Verification

- **Unit** (`test/esp-sr-removal.test.mjs`, run by `npm test`): `removeBuildFeatures` drops the feature
  from the keyed target and leaves the rest intact, re-serialises valid tab-indented JSON, is identity
  for an empty map, and fails loud on an absent target, an absent feature (also on a re-run over an
  already-stripped tree), a target with no features array, and a missing targets array;
  `stripEspSrModelStep` removes the whole esp32s3 srmodels block and only it (surrounding code and the
  generic error check survive, collapsing to a single blank line), and fails loud when the block is
  absent or an esp32s3 guard is not the srmodels step. Each fails before its guard exists and passes
  after. Covers DoD scenario 5. Both helpers were also dry-run against the real pinned-builder
  `build.sh` and `builds.json` (recorded in `## As built`).
- **Post-build integration** (`scripts/0018-verify.mjs`, wired as `verify:esp-sr` in `package.json`,
  R11): given the built zip, asserts no `esp32s3/esp_sr/` entry and the 4MB flash fallback, exiting
  non-zero otherwise. Its error-gate half runs in CI in the `package` job. Covers DoD scenario 2.
- **Dependency tree** (`scripts/0012-verify.mjs`, already wired): esp-sr is in `removedComponents`, so
  the existing check now also proves it is absent from each chip's `dependencies.lock`. Covers DoD
  scenario 3.
- **Shape parity** (`scripts/0002-verify.mjs`, already wired, this slice extends its per-chip match):
  Scenario A passes with `esp32s3/esp_sr/` subtracted via `removedChipSubtrees`. Covers DoD scenario 4.
- **CI build** (`release.yml`): both chips building green is DoD scenario 1, proven by the matrix build
  the next overlay-touching push triggers; a broken `srmodels_bin` removal would fail the esp32s3 build.
- **Hardware boot re-trial** (recorded in `## As built`): the rebuilt esp32s3 libs flashed to the
  PSRAM-less StampS3 Cardputer must still boot to the UI, confirming the 4MB flash change is benign.
  Needs the physical board, so it is a measured result in `## As built`, not a wired CI check. Covers
  DoD scenario 6.

## As built

Filled at merge, in past tense, confirming each Definition-of-Done scenario was met or recording the
deviation. The CI build and the Cardputer boot re-trial are recorded in an amendment below at merge.

## Amendment: 2026-11-14 Local verification and adversarial pass

Built as designed. `removeBuildFeatures` and `stripEspSrModelStep` were dry-run against the real pinned
builder files (`build.sh` at `e68e301`, `configs/builds.json`): esp32s3 features resolved to `[]` with
`idf_libs`/`bootloaders`/`mem_variants` intact, and the srmodels block (514 bytes) was removed with the
bootloader section kept. `scripts/0018-verify.mjs` was shown to fail on a crafted pre-fix artifact
(`esp_sr/` present, `FLASHSIZE_16MB` in the base and a variant `sdkconfig.h`) and pass on the post-fix
one. 99 unit tests, lint and the index were green.

An adversarial pass (one Sonnet reviewer, blind to intent, given the diff plus this repo's `CLAUDE.md`
and `adr/INDEX.md`, told to read its own files and not spawn subagents) returned a ship verdict with no
high findings. Three were fixed at root with before/after regression tests, one was rejected as
consistent with repo convention:

- `stripEspSrModelStep`'s `\n    fi\n` end anchor is a first-match, not a structural brace match, so an
  upstream reshape that moved or dropped the closing `fi` could have silently deleted the wrong span.
  Bounded both ways: the removed slice must carry the srmodels markers (`srmodels.bin`, `AR_SDK`) and
  must not overrun into the next section (`# Build Bootloaders`, `for boot_conf`), failing loud
  otherwise (two added tests).
- `removeBuildFeatures` iterated a non-array feature value (a hand-edited `"esp32s3": "esp_sr"`) by
  character; it now fails loud with a clear message (added test).
- `scripts/0018-verify.mjs` checked only the base `esp32s3/sdkconfig` flash size; it now also asserts no
  esp32s3 mem-variant `sdkconfig.h` re-adds the 16MB define (the variant scenario is not reachable under
  the per-target feature mechanism, but the guard is cheap and mirrors `0016-verify`; proven on the
  crafted zips).
- Rejected: the reviewer flagged `status: accepted` before `## As built` is filled. This is the
  established pattern (slice-0014, slice-0016 accept at write and fill As built by amendment after CI and
  hardware); the CI-build and Cardputer scenarios are recorded in a further amendment below at merge.
