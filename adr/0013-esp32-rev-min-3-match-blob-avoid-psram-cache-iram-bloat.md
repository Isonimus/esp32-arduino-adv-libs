---
id: '0013'
title: "esp32 libs build for ESP32_REV_MIN=3 to match the reference blob and avoid the PSRAM cache-workaround IRAM bloat"
type: architecture
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Context

`v0.0.1` is the unmodified stock build, cut to prove the fork's reason for existing: that our
artifact drops in for the two consumer firmwares where the Bruce blob sits today (ADR-0001). On
2026-11-14 that claim was finally measured, by swapping each firmware's `platformio.ini` libs URL to
`v0.0.1` and building:

- `esp32s3` targets link and image clean (adversary `cardputer`, esp32-wifi-sapper `cardputer`).
- the `esp32` target fails at link: adversary `m5stick` (board `esp32-pico-devkitm-2`) overflows
  `.iram0.text` region `iram0_0_seg` by **7272 bytes**.

Control: the same firmware against the reference Bruce blob links (Flash 79.5%). So the overflow is
specific to our libs, not the firmware.

Root cause, from diffing the two resolved per-chip `sdkconfig`s (ours `5.5.1`, Bruce `5.5.0`, the same
resolved IDF commit `8410210c9a`, so the delta is config, not IDF):

- our esp32 build resolves `CONFIG_ESP32_REV_MIN=0`; Bruce resolves `CONFIG_ESP32_REV_MIN=3`.
- the upstream builder's `configs/defconfig.esp32` enables `CONFIG_SPIRAM=y` but sets no `REV_MIN`, so
  IDF takes the default minimum revision, 0. `defconfig.common` and `defconfig.esp32s3` set no
  `REV_MIN` either.
- at minimum revision below 3 with PSRAM enabled, IDF force-enables `CONFIG_SPIRAM_CACHE_WORKAROUND=y`
  and the `CONFIG_SPIRAM_CACHE_LIB*_IN_IRAM` set (`LIBJMP`, `LIBMATH`, `LIBNUMPARSER`, `LIBIO`,
  `LIBTIME`, `LIBCHAR`, `LIBMEM`, `LIBSTR`, `LIBRAND`, `LIBENV`, `LIBFILE`, `LIBMISC`), relocating
  roughly a dozen libc groups into IRAM to dodge the ESP32 rev 0-2 PSRAM cache hardware errata. That
  relocation is the IRAM growth that overflows. `esp32s3` has no such errata or workaround, which is
  why the S3 targets link.

The consumers already run on the Bruce blob, which is built for `REV_MIN=3`, and their deployed
hardware is rev-3-class (M5StickC Plus2 is an ESP32-PICO-V3, Cardputer is an ESP32-S3). So rev 3 is
their status quo, not a constraint this decision newly imposes.

## Decision

For the `esp32` target, the overlay sets `CONFIG_ESP32_REV_MIN_3=y`, raising the minimum supported
silicon revision to 3.0 and matching the reference blob. That drops the PSRAM cache workaround and its
IRAM-resident libc, restoring drop-in IRAM parity with the blob.

Mechanism: the overlay **appends** the line to the builder's `configs/defconfig.esp32`, a surgical
in-place edit rather than a whole-file copy through the `sdkconfig/` overlay dir (a copy would clobber
upstream's BT, SPIRAM and TWAI-errata settings in that file). `build.sh` composes
`SDKCONFIG_DEFAULTS` with `configs/defconfig.$target` in every esp32 build phase (idf-libs, main,
bootloader, mem-variant), so one append covers all phases. The edit fails loud if `defconfig.esp32` is
absent or already carries the line (upstream changed), mirroring `stripDefconfigSymbols` (ADR-0011).
It is driven by a new `UPSTREAM.lock` field keyed per chip.

Scope: `esp32` only. `esp32s3` has no PSRAM cache errata, already links, and keeps its default; this
ADR does not change S3. Only the enabled chips (`esp32`, `esp32s3`, ADR-0001) are in scope.

## Consequences

- Our `esp32` libs no longer boot on ESP32 silicon revisions 0, 1 and 2. This is deliberate: it
  matches the reference blob and the consumers' rev-3 hardware. A future consumer needing rev < 3
  would have to re-introduce the cache workaround and separately solve the IRAM budget, which the blob
  does not do; that would be a new superseding decision, not a silent exception.
- A new standing invariant (CLAUDE.md section 4): the released `esp32` `sdkconfig` must resolve
  `CONFIG_ESP32_REV_MIN=3` (equivalently, `CONFIG_SPIRAM_CACHE_WORKAROUND` absent). It is checkable
  against the built artifact's `esp32/sdkconfig`, so it is verified by a wired script, not left to
  review. Added with the implementing slice.
- This is the first use of a defconfig-append overlay. The `sdkconfig/` dir was empty and `v0.0.1`
  was pure stock; this establishes "append a line to a per-chip builder defconfig fragment" as a
  mechanism distinct from both the `sdkconfig/` file copy and the `removedDefconfigSymbols` strip
  (ADR-0011).
- `v0.0.1` stays the unmodified baseline. Its `esp32` target is not a drop-in for esp32 boards; this
  ADR is the record of why. The fix ships in the implementing slice and the next tag.
- Narrows ADR-0001's drop-in claim: "unmodified proves drop-in replaceability" held for `esp32s3`
  but not `esp32`, because the stock esp32 defconfig's rev-0 default pulls in a workaround the blob
  disables. ADR-0001's fork model and release sequence stand; only that optimistic assumption is
  corrected, here, by measurement.
