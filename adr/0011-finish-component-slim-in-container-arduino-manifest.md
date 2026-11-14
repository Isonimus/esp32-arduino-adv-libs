---
id: '0011'
title: "Finish the component slim: edit arduino-esp32's manifest in-container, clean the orphaned build config"
type: architecture
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Context

ADR-0006 removed `esp_matter` from the builder's `main/idf_component.yml` and deferred "the rest of
the unused stack (Zigbee, the RainMaker cluster, `esp-sr`, `esp-tflite-micro`, `esp32-camera`)" to a
follow-up, noting the cluster is interdependent and must be removed and CI-verified as a unit. This
decision finishes that slim for the manifest-only part of the stack. The consumers link none of it
(measured in ADR-0006: zero API hits across the two firmwares).

Two facts measured on 2026-11-14 (survey of `espressif/arduino-esp32` at `9b3364c6` and
`espressif/esp32-arduino-lib-builder` at `e68e301`) shape the decision, and neither is covered by
ADR-0006's single host-side rewrite of `main/idf_component.yml`:

1. **Most of the stack is declared in arduino-esp32's own `idf_component.yml`, not the builder's
   `main`.** The Zigbee pair (`esp-zboss-lib`, `esp-zigbee-lib`) and the whole RainMaker cluster
   (`esp_rainmaker`, `rmaker_common`, `network_provisioning`, `esp_insights`, `esp_diag_data_store`,
   `esp_diagnostics`, `cbor`, `qrcode`) are arduino's dependencies. Only `esp32-camera`,
   `esp-tflite-micro` and `esp-sr` are in the builder's `main`. The builder clones arduino at build
   time (`install-arduino.sh`), and the overlay force-checks it out to `arduinoCommit` (ADR-0005);
   arduino's manifest therefore **does not exist on the host when `applyOverlay` runs**, so the
   host-side `removeManagedComponents` cannot reach it.

2. **Removing a managed component is compile-safe because its arduino consumers self-disable.** Every
   consumer of the removed components is either guarded by a Kconfig symbol the removed component's
   own Kconfig defines (so it becomes undefined and the code compiles to nothing) or is never
   compiled into the libs. Measured verdicts (survey, zero RISK rows):
   - Zigbee: `libraries/Zigbee/*` guarded by `#if CONFIG_ZB_ENABLED` (defined by the zigbee
     components' Kconfig).
   - RainMaker: `libraries/RainMaker/*` guarded by `#ifdef CONFIG_ESP_RMAKER_WORK_QUEUE_TASK_STACK`.
   - Insights/Diagnostics: `libraries/Insights/*` guarded by `#ifdef CONFIG_ESP_INSIGHTS_ENABLED`.
   - `network_provisioning`: used in the **core WiFi library** (`libraries/WiFi/WiFiGeneric.*`,
     always compiled) and in WiFiProv, both guarded by `#if CONFIG_NETWORK_PROV_NETWORK_TYPE_WIFI`.
   - `qrcode`: WiFiProv uses `#if __has_include("qrcode.h")` with an `#else` fallback.
   - `esp-tflite-micro`, `esp32-camera`, `cbor`, `esp_diag_data_store`: no reference in `cores/` or
     `libraries/` that is compiled into the libs (examples only, which are not built).

   `defconfig.common` force-sets some of those symbols (`CONFIG_ESP_INSIGHTS_ENABLED=y`,
   `CONFIG_ESP_RMAKER_*`, `CONFIG_DIAG_*`). This does **not** keep the guard alive: a defconfig
   assignment to a symbol no Kconfig declares cannot define it, so with the component (and its
   Kconfig) gone the symbol is simply absent from `sdkconfig.h`, exactly as if the line were not
   there. The line itself becomes an "unknown symbol" warning, harmless the same way ADR-0006's two
   Matter orphans have been harmless in every green build since `v0.0.1`.

`esp-sr` is **not** removed here. It is entangled with the builder's `esp_sr` *feature*: `builds.json`
declares `"features":["esp_sr"]` for `esp32s3`, which injects `configs/defconfig.esp_sr` into every
`idf.py` call and drives a dedicated `idf.py ... srmodels_bin` step in `build.sh` that hard-exits on
failure and copies `srmodels.bin` into the artifact. Removing the component without also removing
that feature and that step breaks `build.sh`. That is a different, heavier mechanism (editing
`build.sh` and `builds.json`), so it is deferred to its own slice.

## Decision

Finish the manifest-only slim, with the removal split across the two manifests by where each
component is declared, and clean the build config the removals orphan, all in the same overlay.

- **Builder `main/idf_component.yml` (host-side, unchanged mechanism):** add `espressif/esp32-camera`
  and `espressif/esp-tflite-micro` to `removedComponents`; `applyOverlay` already calls
  `removeManagedComponents` on this file (ADR-0006).

- **arduino-esp32's `idf_component.yml` (in-container, new mechanism):** `UPSTREAM.lock` gains
  `removedArduinoComponents` (the Zigbee pair and the RainMaker cluster). Because that manifest only
  exists inside the container after `install-arduino.sh` clones arduino and the overlay force-checks
  it out, the edit runs **in-container**: `applyOverlay` copies a dependency-free remover
  (`scripts/overlay/strip-manifest-components.py`) into the builder tree, and the overlay injects a
  call to it into `build.sh` right after the arduino force-checkout and before `idf.py` resolves. The
  script is a faithful port of `removeManagedComponents`' line-based block removal, including its
  fail-loud-on-absent-component contract. It is **python, not node**, because the builder image
  (`tools/docker/Dockerfile`, `ubuntu:22.04`) installs `python3` but no node, so the JS remover
  cannot run there. Two removers in two languages is accepted: the arduino tree is only reachable
  in-container, which has python and not node, so a single shared implementation is not possible.

- **Orphaned build config (host-side):** in the same `applyOverlay`, two new pure rewrites clean what
  the removals leave behind, both fail-loud if their target is absent (a stale cleanup must not
  silently no-op):
  - `stripDefconfigSymbols` deletes the orphaned `CONFIG_...` assignment lines from
    `configs/defconfig.common`: the RainMaker/Insights/Diagnostics lines this slice orphans, plus the
    Matter lines ADR-0006 left (`CONFIG_ENABLE_CHIPOBLE`, `CONFIG_USE_BLE_ONLY_FOR_COMMISSIONING`,
    `CONFIG_ENABLE_ESP_INSIGHTS_TRACE`, `CONFIG_ESP_MATTER_NVS_USE_COMPACT_ATTR_STORAGE`). It matches
    exact symbol names, never prefixes, so the kept `CONFIG_ESP_COREDUMP_*` and `CONFIG_MBEDTLS_*`
    lines are untouched. This is behaviour-neutral (the symbols are already undeclared); it removes
    the warning, not a definition.
  - `stripBuilderCxxDefine` removes the orphaned `-DCHIP_HAVE_CONFIG_H` Matter define from the
    builder's root `CMakeLists.txt` `CXX_COMPILE_OPTIONS` line (the same line ADR-0007's
    `setBuilderCxxStandard` rewrites), applied after the standard rewrite. Nothing reads
    `CHIP_HAVE_CONFIG_H` with the CHIP/Matter sources gone.

- **`managedComponentPins`:** `esp-tflite-micro` leaves it (you cannot pin a component you remove),
  which empties the map. The `pinComponentVersions` mechanism (ADR-0004) stays for future use.

This is a new decision extending ADR-0006, not a supersession: ADR-0006's `esp_matter` removal, its
self-disable reasoning, and its "strip the orphans with the same overlay if needed" note all stand;
this executes that note and generalises the mechanism to arduino's own manifest. ADR-0005's source
pins and ADR-0007's C++ standard rewrite both stand and are depended on (the arduino force-checkout
is where the in-container strip hooks; the CXX line is where the define strip hooks).

## Consequences

- **New standing invariant (CLAUDE.md section 4, row 7):** no removed component appears in either
  enabled chip's resolved `dependencies.lock`, and the kept components still do. Enforced by
  `scripts/0012-verify.mjs` on the built artifact, wired in `package.json` and run in CI, so a future
  change that re-introduces a removed component (or drops a kept one) fails the release.
- The released artifact shrinks by the removed libraries and headers (measured in slice-0012's
  `## As built`). Drop-in shape parity (ADR-0001 Scenario A, `scripts/0002-verify.mjs`) is unaffected:
  it checks top-level entries and per-chip subtree roots (`bin/ lib/ include/ ld/ ...`), all of which
  remain; only individual `.a` and header files under them drop.
- Divergence from the reference blob's *content* grows, deliberately and for the same reason as
  ADR-0006: the consumers do not link Zigbee, RainMaker, TFLite or camera. A consumer that later
  wants one adds it back here.
- Two component-removal paths now exist by necessity: `removedComponents` for the builder's `main`
  manifest (host-side), `removedArduinoComponents` for arduino's own manifest (in-container). A future
  removal uses whichever matches where the component is declared.
- `esp-sr` remains built on `esp32s3`, tracked for its own slice (the `esp_sr`-feature mechanism).
