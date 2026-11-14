---
id: '0017'
title: "Remove esp-sr: strip the esp32s3 esp_sr feature, its srmodels build step and its manifest entry"
type: architecture
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Context

ADR-0006 began the component slim and deferred the rest of the unused stack; ADR-0011 (slice-0012)
finished it for the manifest-only components but explicitly left `esp-sr`, because it is entangled with
the builder's `esp_sr` *feature* and removing the manifest entry alone breaks the esp32s3 build. This
decision removes `esp-sr`, the last unused component. The two consumer firmwares link no esp-sr
speech-recognition API (ADR-0006 survey: zero API hits across both firmwares).

Measured on 2026-11-14 (survey of `espressif/esp32-arduino-lib-builder` at `e68e301`), `esp-sr` touches
four builder surfaces, not one:

1. **`main/idf_component.yml`** declares `espressif/esp-sr` (rule `target in [esp32s3]`). This is the
   same host-side manifest `removeManagedComponents` already edits (ADR-0006, ADR-0011).
2. **`configs/builds.json`** declares `"features":["esp_sr"]` for the `esp32s3` target. `build.sh`
   composes `configs/defconfig.<feature>` into every build phase (idf-libs, main, bootloader,
   mem-variant) for each feature a target lists, so this injects `configs/defconfig.esp_sr` into every
   esp32s3 `idf.py` call.
3. **`build.sh`** runs a dedicated `idf.py ... srmodels_bin` step for esp32s3 and copies the generated
   `srmodels.bin` and `partitions.csv` into the artifact's `esp_sr/` directory, hard-exiting the whole
   build on failure (`if [ $? -ne 0 ]; then exit 1; fi`). The `srmodels_bin` idf.py target is
   registered by esp-sr's own CMake: once `esp-sr` leaves the manifest, the target is unknown and the
   step exits non-zero, failing the esp32s3 build. So the manifest removal *forces* this step's removal.
4. **`configs/defconfig.esp_sr`** carries, besides the speech-model symbols
   (`CONFIG_SR_*`, `CONFIG_EN_SPEECH_COMMAND_ID*`), two non-esp-sr settings:
   `CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y` and `CONFIG_PARTITION_TABLE_CUSTOM=y`. Because the features loop
   appends `defconfig.esp_sr` *after* `defconfig.common` (which sets `CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y`),
   the esp32s3 libs currently ship a **16MB** flash assumption, while `esp32` (no esp_sr feature) ships
   **4MB**. Removing the feature returns esp32s3 to the common 4MB default.

Scenario A shape parity (`scripts/0002-verify.mjs`) matches each chip's first-level subtree members
against the reference blob's exactly. The blob (which keeps esp-sr) ships `esp32s3/esp_sr/`, so removing
that directory would fail the exact-match unless the check learns to subtract a deliberate removal.

## Decision

Remove `esp-sr` fully, in one overlay pass, driven entirely from `UPSTREAM.lock` and fail-loud at every
step. The removal spans the four surfaces above plus the shape-parity check:

- **Manifest (host-side, existing mechanism):** add `espressif/esp-sr` to `removedComponents`.
  `applyOverlay` already calls `removeManagedComponents` on `main/idf_component.yml` (ADR-0006), and
  `scripts/0012-verify.mjs` already asserts every `removedComponents` entry is absent from each chip's
  resolved `dependencies.lock` (ADR-0011), so esp-sr's dependency-tree removal is proven with no new
  verify code.

- **Build feature (host-side, new mechanism):** `UPSTREAM.lock` gains `removedBuildFeatures`
  (`{ "esp32s3": ["esp_sr"] }`). `applyOverlay` calls `removeBuildFeatures`, a pure
  parse/modify/serialize of `configs/builds.json` that drops the named feature from the keyed target's
  `features` array (re-serialized tab-indented to match upstream), failing loud if the target, its
  `features` array, or the named feature is absent. With `esp_sr` gone from the list, `build.sh` no
  longer composes `configs/defconfig.esp_sr` into any esp32s3 phase.

- **srmodels build step (host-side, new mechanism):** the `srmodels_bin` step is esp_sr's build wiring,
  so dropping the `esp_sr` feature drops it too (keeping it would fail the build, per context point 3).
  `stripEspSrModelStep` removes the esp32s3 `srmodels_bin` block from `build.sh`, anchored on the unique
  esp32s3 guard line and its immediate `srmodels_bin` call, through the matching 4-space `fi` that closes
  the guard. `AR_SDK` is defined and read only inside that block (measured: it appears nowhere else in
  `build.sh`), so the removal is self-contained. It fails loud if the block is absent, so an upstream
  reshape cannot silently leave the build-breaking step in place. In `applyOverlay` it is gated on
  `removedBuildFeatures.esp32s3` including `esp_sr`, so the single lock field is the source of truth for
  the whole esp-sr builder removal.

- **Flash size falls to 4MB (deliberate divergence from the blob):** with `defconfig.esp_sr` no longer
  composed, esp32s3 takes `defconfig.common`'s `CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y`, matching `esp32`.
  This is chosen over preserving the blob's 16MB. Rationale: `esp32` already ships 4MB and is
  hardware-proven (adversary `m5stick` link, USB-HID jiggler); 4MB underestimates the actual 8MB
  Cardputer flash, which is the safe direction for a baked value, whereas the blob's 16MB overestimates
  it; and the blob's 16MB already mismatches the 8MB board harmlessly, so the value is soft for the
  consumer (the firmware sets its own flash size and partition table at app build time). A Cardputer
  boot re-trial (slice-0018 Definition of Done) confirms no flash regression on hardware.

- **Shape parity subtracts declared removals:** `UPSTREAM.lock` gains `removedChipSubtrees`
  (`{ "esp32s3": ["esp_sr/"] }`), and `scripts/0002-verify.mjs` subtracts it from the reference member
  set before the per-chip match, rather than weakening the exact-match to a subset: a *kept* root
  (`lib/`, `include/`, ...) going missing must still fail. A declared removal that is not actually in the
  reference fails loud, so a typo cannot silently relax the check.

- **`defconfig.esp_sr` is left in the cloned tree, unreferenced.** Once `esp_sr` leaves the esp32s3
  `features`, nothing composes it (`build.sh` pulls `configs/defconfig.<feature>` only for listed
  features; the overlay passes no `-c CONFIGS`). Deleting it would require a new file-removal overlay for
  one dead file in a throwaway clone, changing no shipped artifact (KISS). Its `FLASHSIZE_16MB` /
  `PARTITION_TABLE_CUSTOM` lines therefore never reach any build.

This extends ADR-0011 (and ADR-0006), not supersedes them: their removals and self-disable reasoning
stand; this finishes the slim for the one component they deferred, and generalises the overlay to the
builder's feature list and esp_sr's build step. It depends on ADR-0005's source-pin force-checkouts only
in that the esp-sr manifest entry is in the builder's own `main` (host-side), unlike the arduino-declared
components ADR-0011 removes in-container.

## Consequences

- **New standing invariant (CLAUDE.md section 4, row 10):** `esp-sr` is fully removed, verified on the
  built artifact by `scripts/0018-verify.mjs` (no `esp32s3/esp_sr/` model directory; the `esp32s3`
  flash size fell back to 4MB, not the esp_sr 16MB) and `scripts/0012-verify.mjs` (absent from each
  chip's `dependencies.lock`). A rebuild that re-introduces esp-sr, its model blob, or the 16MB flash
  size fails the release.
- The esp32s3 artifact shrinks by esp-sr's libraries, headers and the `srmodels.bin` speech model, and
  loses the `esp32s3/esp_sr/` subtree (measured in slice-0018's `## As built`). Drop-in shape parity
  (ADR-0001 Scenario A) remains green: the subtree is a declared `removedChipSubtrees` entry the check
  subtracts; all kept per-chip roots remain.
- Divergence from the reference blob's *content* grows, deliberately and for the same reason as
  ADR-0006 and ADR-0011: the consumers do not link esp-sr. A consumer that later wants speech
  recognition adds it back here (the `esp_sr` feature, its `srmodels_bin` step, and the manifest entry).
- The esp32s3 baked flash size changes from 16MB to 4MB, a deliberate divergence from the blob (see the
  decision's rationale), gated by a hardware boot re-trial.
- A new builder-surface removal path exists: `removedBuildFeatures` for a target's `builds.json`
  features (host-side), alongside `removedComponents` (builder `main` manifest) and
  `removedArduinoComponents` (arduino's own manifest, in-container). A future feature removal uses it;
  a build step bound to a removed feature is stripped by a dedicated anchored rewrite as `esp_sr`'s is.
