---
id: '0015'
title: "esp32s3 quad-PSRAM variants disable SPIRAM_BOOT_HW_INIT so a PSRAM-less board boots"
type: architecture
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Context

The `v0.0.1` esp32s3 libs flash cleanly but **boot-loop on a PSRAM-less board**. Measured on 2026-11-14
on a Cardputer (M5Stack StampS3, which has no PSRAM chip), the adversary firmware built against our
libs aborts at startup and reboots forever:

```
quad_psram: PSRAM chip is not connected, or wrong PSRAM line mode
cpu_start: Failed to init external RAM!
abort() ... Rebooting
```

The Bruce blob does not: the same firmware on Bruce boots, its quad-PSRAM probe failing quietly and
boot continuing on internal SRAM (as the consumer's own `platformio.ini` documents).

Root cause, measured by diffing every `CONFIG_SPIRAM*` define between our and Bruce's `esp32s3`
sdkconfig for the exact memory variant the board links (`dio_qspi`): the only difference is

```
OURS : #define CONFIG_SPIRAM_BOOT_HW_INIT 1
BRUCE: (absent)
```

IDF 5.5's `components/esp_psram/Kconfig.spiram.common` **split the hardware init out** into a new
symbol:

```
config SPIRAM_BOOT_HW_INIT
    depends on SPIRAM
    default "y" if SPIRAM          # auto-on whenever PSRAM support is compiled in
config SPIRAM_BOOT_INIT
    depends on SPIRAM_BOOT_HW_INIT  # the old symbol now sits UNDER the new one
```

The stock builder's `configs/defconfig.qio_ram` (the fragment the quad/qspi esp32s3 variants and the
base `idf-libs` build compose, per `configs/builds.json`) still carries only the pre-split line
`# CONFIG_SPIRAM_BOOT_INIT is not set`. Before the split that disabled all boot-time PSRAM init,
making PSRAM optional. After the split it disables only the upper symbol; `SPIRAM_BOOT_HW_INIT`
defaults on from `SPIRAM=y`, so the hardware init still runs, finds no chip, and aborts. The Bruce
blob was built from an older IDF snapshot that predates the split, so it has no hardware-init symbol at
all and tolerates a missing chip. The builder's `defconfig.opi_ram` path separately avoids the abort
with `CONFIG_SPIRAM_IGNORE_NOTFOUND=y`; the `qio_ram` (quad/qspi) path has no such guard and is the
gap.

This is the second drop-in-breaking stock-vs-blob sdkconfig divergence found in the same trial (the
first was the esp32 IRAM overflow, ADR-0013); both are the unmodified build diverging from the blob's
tuned config. It is independent of ADR-0013 (a different chip and mechanism).

## Decision

For the esp32s3 quad/qspi path, the overlay appends `CONFIG_SPIRAM_BOOT_HW_INIT=n` to
`configs/defconfig.qio_ram`. Setting the new symbol off (it is a plain `default "y" if SPIRAM`, so a
`defaults` value overrides it) disables the boot-time hardware init and, because `SPIRAM_BOOT_INIT`
depends on it, that too. PSRAM-less boards boot on internal SRAM; PSRAM is initialised at runtime
where present (arduino-esp32's path), which is how the pre-split `qio_ram` variant already worked and
how the blob works. This completes the intent the stale `# CONFIG_SPIRAM_BOOT_INIT is not set` line was
already expressing.

`qio_ram` is composed by the base `idf-libs` build, both quad/qspi memory variants (`qio_qspi`,
`dio_qspi`) and the `qio_ram` bootloaders, so one appended line covers every quad path. The mechanism
is the `addedDefconfigLines` overlay from ADR-0013 (slice-0014), keyed here by `defconfig.qio_ram`.

**Alternative considered and rejected:** `CONFIG_SPIRAM_IGNORE_NOTFOUND=y` (what `defconfig.opi_ram`
uses). It also boots a PSRAM-less board, but it keeps the hardware init running and its Kconfig help
states it forces several WiFi configs to their no-PSRAM defaults (disabling `WIFI_CACHE_TX_BUFFER_NUM`
and `ESP_WIFI_AMSDU_TX_ENABLED`). On a WiFi-pentest consumer that is an unwanted behavioural change to
the RF stack, and it reverses rather than restores the `qio_ram` fragment's existing "no boot PSRAM
init" intent. `SPIRAM_BOOT_HW_INIT=n` reproduces the blob's behaviour most faithfully and adds no WiFi
side effects, so it is preferred. The `opi_ram` path is left as upstream ships it (its
`IGNORE_NOTFOUND=y` already tolerates a missing octal chip); this ADR changes only the quad path.

## Consequences

- The esp32s3 quad/qspi libs no longer hardware-initialise PSRAM at boot. A board that genuinely has
  quad PSRAM and relied on boot-time init would initialise it at runtime instead; this matches the
  blob and the pre-split `qio_ram` behaviour, so it is not a regression for the consumers who run on
  the blob today. A future need for boot-time quad-PSRAM init would be a new superseding decision.
- A new standing invariant (CLAUDE.md section 4): the released esp32s3 quad/qspi variants must not
  enable `SPIRAM_BOOT_HW_INIT`. Checkable against the built artifact's variant `sdkconfig.h`, so it is
  verified by a wired script. Added with the implementing slice.
- `v0.0.1` is confirmed not a clean drop-in on esp32s3 either (it boot-loops a PSRAM-less board); with
  ADR-0013's esp32 finding, neither chip's unmodified build drops in. Both sdkconfig-parity fixes
  precede the patch-stack roadmap (ADR-0001 section 7).
- Reuses the `addedDefconfigLines` mechanism (ADR-0013) for a non-chip (memory-fragment) key, so the
  esp32 REV_MIN verify is scoped to enabled-chip keys and this slice adds its own variant-level verify.
