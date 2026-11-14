---
id: '0016'
title: "Disable SPIRAM_BOOT_HW_INIT on the esp32s3 quad/qspi path so a PSRAM-less board boots"
type: slice
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Goal

Make the esp32s3 libs boot on a PSRAM-less board, so they are a real drop-in for the Cardputer-class
consumers. A `v0.0.1` hardware test on 2026-11-14 boot-looped a StampS3 Cardputer (no PSRAM): our libs
build the esp32s3 quad/qspi variants with `CONFIG_SPIRAM_BOOT_HW_INIT=y`, so the boot-time hardware
PSRAM init aborts when no chip is present, where the Bruce blob boots quietly on internal SRAM
(ADR-0015). The cause is IDF 5.5 splitting `SPIRAM_BOOT_HW_INIT` out from `SPIRAM_BOOT_INIT`, which
left the stock `defconfig.qio_ram`'s `# CONFIG_SPIRAM_BOOT_INIT is not set` only half-disabling the
init. This slice applies the ADR-0015 decision: the overlay appends `CONFIG_SPIRAM_BOOT_HW_INIT=n` to
`configs/defconfig.qio_ram`, matching the blob, and re-runs the hardware boot on the Cardputer to
confirm the abort is gone. It reuses the `addedDefconfigLines` overlay that slice-0014 introduced.

## Definition of Done

- **Given** `UPSTREAM.lock` keying `defconfig.qio_ram` with `CONFIG_SPIRAM_BOOT_HW_INIT=n`
- **When** the overlay applies and the esp32s3 libs are rebuilt
- **Then** each esp32s3 quad/qspi variant (`qio_qspi`, `dio_qspi`) and the base `esp32s3/sdkconfig` no
  longer enable `SPIRAM_BOOT_HW_INIT` (its `#define ... 1` is absent from the variant `sdkconfig.h`),
  asserted by `scripts/0016-verify.mjs` against the built zip, exiting non-zero otherwise

- **Given** the rebuilt libs flashed to a PSRAM-less StampS3 Cardputer
- **When** the board boots
- **Then** it reaches the firmware UI with no `Failed to init external RAM!` abort and no boot loop
  (the quad-PSRAM probe fails quietly and boot continues on internal SRAM, matching the blob)

- **Given** the same rebuild
- **When** both chips build in CI and the esp32 and octal (`opi`) paths are inspected
- **Then** both chips build green, and the append targets `defconfig.qio_ram` only: the `opi_ram`
  (octal) path and the esp32 config are unchanged by this slice (ADR-0015)

## Design

Measured basis and the decision (including the rejected `IGNORE_NOTFOUND=y` alternative) are in
ADR-0015. What this slice builds:

- **One lock line.** `addedDefconfigLines` gains `"defconfig.qio_ram": ["CONFIG_SPIRAM_BOOT_HW_INIT=n"]`.
  `build.sh` composes `configs/defconfig.qio_ram` into the base `idf-libs` build, both quad/qspi memory
  variants and the `qio_ram` bootloaders (`configs/builds.json`), so one appended line covers every
  quad path. No new overlay code: `appendDefconfigLines` / `applyAddedDefconfigLines` (slice-0014)
  already append to any keyed builder defconfig fragment and fail loud on a clash or an absent file.
- **The verify.** `scripts/0016-verify.mjs` reads the esp32s3 quad/qspi variant `include/sdkconfig.h`
  files from the built zip and asserts none defines `CONFIG_SPIRAM_BOOT_HW_INIT`, exit-gating in CI. It
  mirrors `scripts/0012-verify.mjs`'s wired, artifact-inspecting shape but reads the per-variant header
  rather than the per-chip lock.
- **Scoping the esp32 REV_MIN verify.** `addedDefconfigLines` now holds both a chip key
  (`defconfig.esp32`) and a memory-fragment key (`defconfig.qio_ram`). `scripts/0014-verify.mjs`
  iterated every key as a `defconfig.<chip>`; it is scoped to keys whose chip is in `enabledChips`, so
  it ignores the memory-fragment key (which `0016-verify` owns) rather than looking for a
  `qio_ram/sdkconfig` entry that does not exist.
- **Standing invariant 9** (CLAUDE.md section 4): the released esp32s3 quad/qspi variants do not enable
  `SPIRAM_BOOT_HW_INIT`, `verified_by: scripts/0016-verify.mjs`.

**Existing code considered.** The `addedDefconfigLines` overlay and its `appendDefconfigLines` /
`applyAddedDefconfigLines` helpers (ADR-0013, slice-0014) are reused verbatim: this slice adds data, not
mechanism, which is the point of having keyed the field by defconfig basename. The verify follows
`scripts/0012-verify.mjs` and `scripts/0014-verify.mjs`. No change to `build.mjs` overlay logic.

## Verification

- **Overlay helper** (`test/rev-min-overlay.test.mjs`, slice-0014, run by `npm test`): the
  `appendDefconfigLines` / `applyAddedDefconfigLines` append-and-fail-loud behaviour this slice relies
  on is already covered; this slice adds a lock entry, not new helper code, so it adds no helper test.
- **Post-build integration** (`scripts/0016-verify.mjs`, wired as `verify:psram` in `package.json`,
  R11): given the built zip, asserts the esp32s3 quad/qspi variant `sdkconfig.h` files do not define
  `CONFIG_SPIRAM_BOOT_HW_INIT`, exiting non-zero otherwise. Its error-gate half runs in CI in the
  `package` job. Covers DoD scenario 1.
- **CI build** (`release.yml`): both chips building green is the build half of DoD scenario 3.
- **Hardware boot re-trial** (recorded in `## As built`): the rebuilt esp32s3 libs flashed to the
  PSRAM-less StampS3 Cardputer must boot to the UI with no external-RAM abort. This needs the physical
  board, so it is a measured result in `## As built`, not a wired CI check. Covers DoD scenario 2, the
  one that first exposed the bug.
- **esp32-scope verify unaffected** (`scripts/0014-verify.mjs`): rescoped to enabled-chip keys, its
  existing esp32 REV_MIN assertion is unchanged and still runs. Covers the no-regression half of DoD
  scenario 3.

## As built

Filled at merge, in past tense, confirming each Definition-of-Done scenario was met or recording the
deviation. The rebuild and the Cardputer boot re-trial are recorded in an amendment below at merge.
