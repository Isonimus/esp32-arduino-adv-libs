---
id: '0022'
title: "Add the esp32 SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY sdkconfig-append overlay so consumers get static PSRAM .bss"
type: slice
status: accepted
date: 2026-11-15
supersedes: []
superseded_by: []
---

## Goal

Ship the esp32 libs with `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` so a consumer can place a large
static buffer in PSRAM with `EXT_RAM_BSS_ATTR`, instead of the runtime `heap_caps_malloc` + placement-new
glue it is forced into today. The driving need is `esp32-wifi-sapper:ADR-0080`: on the classic ESP32
M5StickC Plus2, two ~28 KB `CrackedManifest` buffers in static `.bss` overflow `dram0_0_seg` by 28816 bytes,
and the clean `EXT_RAM_BSS_ATTR` fix was unavailable because the precompiled libs ship the flag unset (its
"Mechanism probe" measured exactly that). `esp32-wifi-sapper:ADR-0080` section 5 names this patch as its own
supersession condition. Patch #2 (roadmap `v0.2.0`, ADR-0021) applies the ADR-0021 decision: append the flag
to the builder's `configs/defconfig.esp32` through the existing `addedDefconfigLines` overlay (the same path
that sets `REV_MIN_3`), scoped to esp32 only, and add the standing invariant that the released esp32 config
surfaces carry it. The flag's two preconditions (`CONFIG_SPIRAM=y`, and the PSRAM cache workaround off via
`REV_MIN_3`) are already met from ADR-0013, measured 2026-11-15.

## Definition of Done

- **Given** the builder's `configs/defconfig.esp32` already carrying `CONFIG_ESP32_REV_MIN_3=y` (ADR-0013)
- **When** the overlay applies the esp32 defconfig append with both lines
- **Then** the file gains `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` alongside the preserved
  `CONFIG_ESP32_REV_MIN_3=y` and every stock line, and a second application (or an upstream that already set
  the symbol, in any variant form) fails loud naming the line rather than appending a duplicate

- **Given** the rebuilt esp32 release artifact
- **When** `scripts/0022-verify.mjs` inspects `esp32/sdkconfig` and each esp32 memory-variant
  `include/sdkconfig.h`
- **Then** every one carries `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY` set (base `=y`, variant
  `#define ... 1`), exiting non-zero otherwise; and the same verify exits non-zero on the pre-patch v0.0.2
  artifact (which ships the flag unset)

- **Given** the rebuilt libs
- **When** both enabled chips build in CI, and a consumer firmware with an `EXT_RAM_BSS_ATTR`-tagged static
  buffer is linked against the rebuilt esp32 libs
- **Then** both chips build green, and the consumer links with the tagged buffer placed in `.ext_ram.bss`
  (PSRAM) rather than overflowing `dram0_0_seg`, producing an image

- **Given** the same rebuild
- **When** `esp32s3` builds and its `sdkconfig` is inspected
- **Then** `esp32s3` still builds green and its resolved config is unchanged by this slice (the append
  targets `defconfig.esp32` only; esp32s3 is deliberately out of scope, ADR-0021 section 2)

## Design

Measured basis and the decision are in ADR-0021. What this slice builds:

- **A one-line lock entry, no new build code.** `UPSTREAM.lock` `addedDefconfigLines["defconfig.esp32"]`
  gains `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` next to the existing `CONFIG_ESP32_REV_MIN_3=y`.
  The append runs through the already-shipped `applyAddedDefconfigLines` -> `appendDefconfigLines`
  (ADR-0013), which already handles a multi-line list and fails loud on a present symbol or absent file.
  `build.sh` composes `configs/defconfig.esp32` into every esp32 build phase (idf-libs, main, bootloader,
  and each memory variant), so one appended line reaches the base `esp32/sdkconfig` and both variant
  `sdkconfig.h` headers a consumer compiles `EXT_RAM_BSS_ATTR` against.
- **The verify.** `scripts/0022-verify.mjs` reads the esp32 base `sdkconfig` (`CONFIG_X=y`) and each esp32
  memory-variant `include/sdkconfig.h` (`#define CONFIG_X 1`) from the built zip, and asserts the flag is
  set in all of them, exit-gating in CI. It owns the consumer-facing variant headers that
  `scripts/0014-verify.mjs` does not read, and re-checks the base for defense in depth. It mirrors
  `scripts/0016-verify.mjs`'s base-plus-variant shape.
- **Standing invariant 12** (CLAUDE.md section 4): the released esp32 config surfaces carry
  `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY` set, `verified_by: scripts/0022-verify.mjs`.

**Existing code considered.** The append mechanism (`appendDefconfigLines` / `applyAddedDefconfigLines`,
ADR-0013) is reused verbatim, including its multi-line support already covered by
`test/rev-min-overlay.test.mjs`; no new overlay code is written, so there is no new logic to unit-test
(ADR-0021 adds config data, not a code path). The verify follows `scripts/0016-verify.mjs` (base Kconfig +
variant C-header), not `scripts/0014-verify.mjs`, because the consumer-facing surface here is the variant
`sdkconfig.h`, which 0014 does not inspect. The `sdkconfig/` file-copy overlay was again not used (it would
clobber `defconfig.esp32`'s stock lines), consistent with ADR-0013.

## Verification

- **Unit** (`test/rev-min-overlay.test.mjs`, run by `npm test`): the append/preserve/fail-loud logic and the
  multi-line case (`appends several lines in order`) that this slice exercises are already covered; each
  assertion fails before the helper exists and passes after. Covers DoD scenario 1. No new test is added
  because this slice introduces no new code path (ADR-0021 section 1).
- **Post-build integration** (`scripts/0022-verify.mjs`, wired as `verify:spiram-bss` in `package.json`,
  R11): given the built zip, asserts the flag is set in `esp32/sdkconfig` and every esp32 variant
  `sdkconfig.h`, exiting non-zero otherwise. Its error-gate half runs in CI in the `package` job. Shown to
  fail on the pre-patch v0.0.2 artifact and pass on the rebuilt one (the fail-before/pass-after record is in
  `## As built`). Covers DoD scenario 2. The base line is additionally covered generically by
  `scripts/0014-verify.mjs` (ADR-0013).
- **CI build** (`release.yml`): both chips building green is the build half of DoD scenarios 3 and 4, proven
  by the matrix build the overlay-touching push triggers.
- **Consumer EXT_RAM_BSS_ATTR link trial** (recorded in `## As built`, like slice-0014's drop-in re-trial):
  a consumer firmware with an `EXT_RAM_BSS_ATTR`-tagged static buffer re-linked against the rebuilt esp32
  libs must link with the buffer in `.ext_ram.bss` rather than overflowing DRAM. This needs the consumer
  tree, so it is a measured result in `## As built`, not a wired CI check. Covers DoD scenario 3's link half.
  On-device PSRAM placement confirmation is `esp32-wifi-sapper:ADR-0080`'s operator proof, not this repo's.
- **S3 untouched** (`scripts/0022-verify.mjs` scoped to esp32, and the CI build): S3 builds green and the
  append targets `defconfig.esp32` only. Covers DoD scenario 4.

## As built

Filled in at merge, in past tense, confirming each Definition-of-Done scenario was met or recording the
deviation. The build, verify fail-before/pass-after, and consumer link trial results are recorded in
amendments below at merge.
