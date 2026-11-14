---
id: '0021'
title: "Enable CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY on the esp32 libs so consumers place static buffers in PSRAM via EXT_RAM_BSS_ATTR"
type: architecture
status: accepted
date: 2026-11-15
supersedes: []
superseded_by: []
---

## Context

Patch #2 on the roadmap (ADR-0001 section 7, release `v0.2.0`) is `sdkconfig-spiram-bss-ext`, driven by
`esp32-wifi-sapper:ADR-0080`. That ADR brought up the M5StickC Plus2 (ESP32-PICO-V3-02, the first classic
ESP32 PSRAM board in that tree) and its device link **failed**: `.dram0.bss` overflowed `dram0_0_seg` by
28816 bytes, because two fixed `CrackedManifest` buffers (~28 KB each) sit in static `.bss` and the classic
ESP32 has a tighter usable static-DRAM budget than the ESP32-S3 the firmware was developed on.

The clean fix is to tag those buffers `EXT_RAM_BSS_ATTR` so they land in the `.ext_ram.bss` section mapped
into external PSRAM, with no runtime allocation. `esp32-wifi-sapper:ADR-0080` measured (section "Mechanism
probe") that this was **not available** against the precompiled libs it depends on, because those libs ship
`CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY` **unset**: with it unset, the IDF macro `EXT_RAM_BSS_ATTR`
expands to nothing, so a tagged buffer stays in regular `.bss` (DRAM) and the overflow stands. The consumer
was forced into the interim mechanism: runtime `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` plus placement-new,
with a fail-loud null guard. `esp32-wifi-sapper:ADR-0080` section 5 records this explicitly as interim and
names its own supersession condition: *"When the shared patched-libs initiative lets us own the IDF build and
set `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y`, `EXT_RAM_BSS_ATTR` becomes a one-line static attribute
... At that point this ADR is superseded by the attribute form."* This repo is that initiative; patch #2 sets
the flag so that supersession can happen.

Measured on 2026-11-15 on our shipped `v0.0.2` artifact (`esp32/sdkconfig`), the two preconditions the flag
needs are already met and the flag itself is the only thing missing:

- `CONFIG_SPIRAM=y` is set (the flag's hard Kconfig dependency: PSRAM support must be compiled into the
  esp32 libs, and it is). `CONFIG_SPIRAM_USE_MALLOC=y` is also set.
- `CONFIG_ESP32_REV_MIN_3=y` with no `CONFIG_SPIRAM_CACHE_WORKAROUND` (invariant 8, ADR-0013). The cache
  workaround and external-RAM `.bss` are mutually exclusive on the classic ESP32; patch #2 depends on the
  workaround being off, which invariant 8 already guarantees. Had we shipped rev 0 (workaround forced on),
  patch #2 would be impossible, so the two decisions reinforce each other.
- `# CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY is not set` in the base config, and the symbol is absent
  (so, unset) in both variant headers `esp32/qio_qspi/include/sdkconfig.h` and
  `esp32/dio_qspi/include/sdkconfig.h`. The `.ext_ram.bss` output section is already present in
  `esp32/ld/sections.ld`; the config is the gate that makes `EXT_RAM_BSS_ATTR` route a buffer into it.

Unlike patch #1 (ADR-0019), where the roadmap's framing ("declare the symbol weak in source") turned out to
be impossible against a vendored binary blob, patch #2 is exactly the sdkconfig overlay the roadmap imagined,
and both of its preconditions are already in place from earlier patches.

**Safety for the shared libs (measured intent, not assumed):** `SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY` is a
pure opt-in. It changes where a symbol lives *only* for symbols explicitly tagged `EXT_RAM_BSS_ATTR` in
source; IDF and Arduino core tag none by default, so a consumer that does not use the attribute sees no
change, and a classic-ESP32 board with **no** PSRAM is unaffected (the `.ext_ram.bss` section stays empty, at
zero cost). The flag starts mattering only when a consumer opts in. This is what makes it safe to set in libs
shared across every esp32 board. The CI build (both chips green) and the consumer `EXT_RAM_BSS_ATTR` link
trial confirm it before anything ships.

## Decision

### 1. Set the flag on the esp32 libs, in-build, via the existing defconfig overlay

Append `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` to the builder's `configs/defconfig.esp32` through the
existing `addedDefconfigLines` overlay (ADR-0013, `applyAddedDefconfigLines` -> `appendDefconfigLines` in
`scripts/build.mjs`). No new `build.mjs` code: this reuses the exact, already-tested mechanism that sets
`CONFIG_ESP32_REV_MIN_3=y`. `build.sh` composes `configs/defconfig.esp32` into every esp32 build phase
(idf-libs, main, bootloader, and each memory variant), so one appended line reaches the base
`esp32/sdkconfig` and both variant `esp32/<variant>/include/sdkconfig.h` headers, which is where a consumer's
compiler reads `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY` to expand `EXT_RAM_BSS_ATTR`. `appendDefconfigLines`
fails loud if the symbol is already present or the target file is absent, so an upstream change cannot let the
append silently no-op.

### 2. Scope: esp32 only

The driving need (`esp32-wifi-sapper:ADR-0080`) is the classic ESP32 M5StickC Plus2, the only board that
overflowed. esp32s3 is deliberately **not** included:

- We ship esp32s3 with `CONFIG_SPIRAM_BOOT_HW_INIT` off (ADR-0015, invariant 9) because the reference
  StampS3 Cardputer has no PSRAM chip. Routing `.ext_ram.bss` into a PSRAM region that may not exist on the
  reference board is a risk with no consumer asking for it.
- No consumer uses `EXT_RAM_BSS_ATTR` on esp32s3; the S3 had the DRAM slack that the classic ESP32 lacked,
  which is why `esp32-wifi-sapper:ADR-0080` exists only for the classic part.

If a PSRAM esp32s3 consumer later needs static external `.bss`, that is a separate concern with its own
driving ADR (one concern per patch, invariant 1), not a speculative addition here.

### 3. This is a distinct concern from the REV_MIN_3 append, co-located in the same file

`defconfig.esp32` will carry two of our appended lines (`CONFIG_ESP32_REV_MIN_3=y` from ADR-0013 and
`CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` here). They are unrelated symbols with independent
justifications that happen to target the same per-chip defconfig; co-location in one file is not two concerns
in one patch (invariant 1). Each is traceable to its own ADR, and each is checked independently (REV_MIN by
`scripts/0014-verify.mjs`, this flag by `scripts/0022-verify.mjs`).

## Consequences

- **Standing invariant created** (added to `CLAUDE.md` section 4 as row 12 in this same commit): the shipped
  esp32 libs carry `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY` set, in the base `esp32/sdkconfig` (`=y`)
  and in every esp32 memory-variant `sdkconfig.h` (`#define ... 1`), so a consumer's `EXT_RAM_BSS_ATTR`
  routes a static buffer into PSRAM-backed `.ext_ram.bss` rather than into DRAM `.bss`;
  `verified_by: scripts/0022-verify.mjs` (runs on the built zip's esp32 config surfaces).
- **The base `esp32/sdkconfig` line is also covered generically by `scripts/0014-verify.mjs`** (ADR-0013),
  which asserts every `addedDefconfigLines` entry lands in the resolved per-chip config. 0022-verify owns the
  consumer-facing variant headers that 0014 does not read, and re-checks the base for defense in depth.
- **`esp32-wifi-sapper:ADR-0080` can be superseded on the release that carries this.** On repinning to the
  release with patch #2, the consumer replaces the runtime `heap_caps_malloc`/placement-new/fail-loud glue
  with a one-line `EXT_RAM_BSS_ATTR` static attribute, as `esp32-wifi-sapper:ADR-0080` section 5 foresaw. That is consumer work
  tracked in the sibling repo's ledger, not here.
- **No change to any consumer that does not use `EXT_RAM_BSS_ATTR`**, and no change to a no-PSRAM esp32
  board: the flag is a pure opt-in and the `.ext_ram.bss` section stays empty when nothing is tagged.
- **`patches/` stays empty.** Patch #2, like the other sdkconfig patches (ADR-0013, ADR-0015), is an overlay
  lock entry, not a numbered source diff. The roadmap's "patch #2" label is kept for continuity.
- ADR-0001 is not superseded: its fork model, release shape, and invariants stand. This ADR adds one
  sdkconfig overlay and one standing invariant, consistent with ADR-0013 and ADR-0015.
