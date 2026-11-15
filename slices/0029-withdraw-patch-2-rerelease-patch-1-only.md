---
id: '0029'
title: "Withdraw the esp32 SPIRAM_ALLOW_BSS overlay and re-release with patch #1 alone"
type: slice
status: accepted
date: 2026-11-15
supersedes: ['0022']
superseded_by: []
---

## Goal

Execute ADR-0028: remove patch #2 (`CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y`) from the esp32 overlay
and cut a new release carrying patch #1 (the weak `ieee80211_raw_frame_sanity_check`, ADR-0019) alone.
Patch #2 shipped in `v0.1.0` and crash-loops every esp32 board: the flag activates `EXT_RAM_BSS_ATTR` for
the Arduino core's own globals, which our libs place in `.ext_ram.bss` but never zero (PSRAM boot-init is
off, ADR-0015), so the core dereferences the `0xaa` fill and `LoadProhibited`-panics on boot
(`esp32-wifi-sapper:ADR-0123`, reproduced on `m5stickc_plus2` and `cyd_3248s035c`). The one consumer use
it existed for (`esp32-wifi-sapper:ADR-0080`'s static manifest placement) was independently infeasible
(the polymorphic manifest's constructor runs before the late `psramInit()`), and no other consumer uses
the attribute, so the flag delivers no benefit and one real harm. This slice reverses what slice-0022
shipped, returning the esp32 config to known-good, and adds the on-device boot gate ADR-0021 deferred and
ADR-0028 now requires.

## Definition of Done

- **Given** `UPSTREAM.lock`'s `addedDefconfigLines["defconfig.esp32"]` with the
  `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` line removed (and `CONFIG_ESP32_REV_MIN_3=y` kept), and
  `scripts/0022-verify.mjs` plus its `verify:spiram-bss` wiring deleted
- **When** the release builds both enabled chips and packages the zip
- **Then** the esp32 base `sdkconfig` reads `# CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY is not set` and
  neither esp32 variant `include/sdkconfig.h` defines the symbol (the flag is gone from every surface a
  consumer compiles against), and both chips build green

- **Given** the patch-#1-only release firmware for a consumer that links against it
- **When** at least one esp32 board and one esp32s3 board are flashed and booted
- **Then** each boots clean with no `LoadProhibited` reboot loop (the esp32 `.ext_ram.bss` corruption is
  gone), confirming the gate ADR-0021 deferred to "the operator's to run" and ADR-0028 decision 4 now
  requires before tagging

- **Given** patch #1 is unaffected by this withdrawal
- **When** `scripts/0020-verify.mjs` inspects the built zip's per-chip `libnet80211.a`
- **Then** `ieee80211_raw_frame_sanity_check` is still **weak** (`W`) on every chip (standing invariant 11
  holds; the re-release is a drop-in for the weaken-hook retirement the consumers still want)

## Design

What this slice changes, and nothing more. The measured basis and the decision are in ADR-0028.

- **The overlay line, removed.** `UPSTREAM.lock` `addedDefconfigLines["defconfig.esp32"]` drops its second
  entry, leaving `["CONFIG_ESP32_REV_MIN_3=y"]`. The lock's `addedDefconfigLinesComment` loses its patch #2
  paragraph and gains a one-line note that the flag was withdrawn (ADR-0028). No `build.mjs` change: the
  overlay reads the lock, so one fewer line is one fewer append, through the same tested
  `appendDefconfigLines` path.
- **The verify, deleted.** `scripts/0022-verify.mjs` and the `"verify:spiram-bss"` entry in `package.json`
  are removed. Nothing asserts a flag that is no longer set; `scripts/0014-verify.mjs` still asserts every
  remaining `addedDefconfigLines` entry (now just REV_MIN_3) lands in the resolved config, so its coverage
  is unchanged for what stays.
- **The standing invariant, removed.** `CLAUDE.md` section 4 row 12 is deleted. Row 13 (ADR-0026) keeps
  its number so its citations do not dangle; the gap at 12 marks a withdrawn rule, per ADR-0028 decision 2.
- **Patch #1 and everything else, untouched.** `weakenArchiveSymbols`, the slim, the pins, the drift gate,
  and both chips' `dependencies.lock` are not edited (the flag is an sdkconfig line, not a component, so no
  lock snapshot moves). The re-release differs from `v0.1.0` only by the absence of the one defconfig line.

**Existing code considered.** The removal reuses the `addedDefconfigLines` mechanism (ADR-0013) by
subtracting from it, so there is no new overlay helper and no new build path. `scripts/0014-verify.mjs`
already covers the base-config landing of whatever the lock lists, so deleting `0022-verify.mjs` leaves no
gap for the lines that remain; the only thing it stops checking is the flag that is deliberately gone. No
source patch, no `patches/` entry (patch #2 was never a numbered source diff), and `patchStackHash` stays
the empty-stack sentinel it already was.

## Verification

- **Config-surface absence** (Definition-of-Done scenario 1): there is no new wired verify script, by
  design: this slice *removes* an assertion rather than adding one, and repo rule 3 does not ask for a
  script to prove a flag's absence. The absence is confirmed once, at merge, by unzipping the built release
  and reading the esp32 `sdkconfig` and both variant `sdkconfig.h` (the inverse of what the deleted
  `0022-verify.mjs` asserted). Recorded in `## As built`. CI building both chips green is the
  machine-checkable half.
- **On-device boot** (Definition-of-Done scenario 2, ADR-0028 decision 4, the operator's to run): a
  consumer firmware pinned to the re-release is flashed to an esp32 board and an esp32s3 board; each boots
  with no `LoadProhibited` loop. This is the gate the link cannot assert and whose deferral let `v0.1.0`
  ship broken. Recorded in `## As built` when run; the release is not tagged before it passes.
- **Patch #1 still weak** (Definition-of-Done scenario 3): `scripts/0020-verify.mjs` (`npm run
  verify:weak-deauth`, standing invariant 11) runs in the `release.yml` `package` job on the re-release
  and asserts `nm` reports the symbol weak on every chip. Recorded in `## As built`.

## As built

Filled in at merge, in past tense, confirming each Definition-of-Done scenario was met or recording the
deviation. The config-surface absence and the per-chip build/weak-symbol results are recorded in an
amendment below when the release build is green; the on-device esp32 and esp32s3 boot proofs are recorded
when the operator runs them, and the release is tagged only after they pass.

## Amendment: 2026-11-15 Shipped as v0.1.1; boot-verified on esp32 and esp32s3 before the tag

Shipped as designed. Published as `v0.1.1` (release run `43727341068`, asset
`adv-esp32-arduino-libs-v5.5-20261115-e68e301.zip`), with `v0.1.0` withdrawn on its GitHub Release.

**Definition-of-Done scenario 1 (config-surface absence), met.** Both chips built green on the tag build
and on the prior `main` build-only run (`43724215684`, same commit `01f30cf`). Unzipping the built release:
the esp32 base `sdkconfig` reads `# CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY is not set`, both esp32
variant headers (`qio_qspi`, `dio_qspi`) do not define the symbol, and `CONFIG_ESP32_REV_MIN_3=y` is kept
(the REV_MIN append survived the removal). The SHA-256 sidecar matched. This is the inverse of the deleted
`0022-verify.mjs`, confirmed once by hand at merge as the slice's Verification section foresaw.

**Definition-of-Done scenario 3 (patch #1 still weak), met.** `scripts/0020-verify.mjs` passed in the
`release.yml` `package` job on both builds (`nm` reports `ieee80211_raw_frame_sanity_check` weak on each
chip); the `0027` drift gate also passed, so the dependency tree is unchanged.

**Definition-of-Done scenario 2 (on-device boot), met.** A consumer (`esp32-wifi-sapper`) env was pointed
at the build-only artifact of `main@01f30cf` and flashed to two boards (its `platformio.ini` edit was
temporary and reverted after):

- **esp32 + PSRAM, M5StickC Plus2** (the board `v0.1.0` crash-looped with `EXCVADDR=0xaaaaa9dc`): one
  `POWERON_RESET`, no reboot loop, zero crash markers (no `Guru Meditation` / `LoadProhibited` / backtrace)
  across the capture window, reaching `[STATE] phase=provisioning heap_free=161496 heap_max=2064372
  disp=240x135` (2 MB PSRAM up, display live). The `.ext_ram.bss` corruption is gone.
- **esp32s3, T-embed** (never affected, patch #2 is esp32-only): clean boot, zero crash markers,
  `[STATE] phase=station_connect heap_free=140900 heap_max=8257524 disp=320x170` (8 MB octal PSRAM up).

The boot-tested artifact and the published `v0.1.1` asset are both builds of `main@01f30cf` and are
functionally identical (same verified sdkconfig surfaces and same weak symbol, asserted by the `package`-job
verifies on both), though not bit-identical: the release payload is not yet byte-reproducible by design
(ADR-0026, LEDGER). The ADR-0028 decision 4 gate (boot an esp32 and an esp32s3 board before tagging) was
met before `v0.1.1` was tagged.
