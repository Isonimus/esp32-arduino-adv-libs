---
id: '0006'
title: "Remove managed components the consumers never use, starting with esp_matter"
type: architecture
status: accepted
date: 2026-11-13
supersedes: []
superseded_by: []
---

## Context

With the source and component pins corrected (ADR-0004, ADR-0005 and its amendment), the first
build to get all three source checkouts right (run `43497352238`, commit `352f3b9`) compiled for
~18 minutes on each chip and then failed, on both `esp32` and `esp32s3`, at the same place deep in
the build:

```
FAILED: esp-idf/espressif__esp_matter/.../esp_matter_console_otcli.cpp.obj
.../OpenthreadLauncher.h:21:10: fatal error: esp_openthread_types.h: No such file or directory
```

The `openthread` component is present and the header exists at
`esp-idf/components/openthread/include/esp_openthread_types.h`; IDF's own diagnostic says the
feature "is not enabled in the configuration". `esp_matter`'s OpenThread CLI console
(`esp_matter_console_otcli.cpp`) includes that header unconditionally, but the openthread component
only exposes its include directory when Thread is enabled, and Thread is off on `esp32`/`esp32s3`
(neither has an 802.15.4 radio).

The component *versions* are not the problem: the blob's `versions.txt`, re-read on 2026-11-13,
records `esp_matter 1.4.1`, exactly our pin, and the blob built it. The difference is the **builder
config**. The blob's first `versions.txt` line is `lib-builder: bruce b5b0771`: it was built by
`bmorcelli`'s fork of the lib-builder, which carries its own sdkconfig and component wiring. This
repo deliberately builds on the stock `espressif/esp32-arduino-lib-builder` at `e68e301` (ADR-0001,
the whole point being to not depend on the Bruce ecosystem). Under the stock builder's config,
`esp_matter`'s console cannot build on these chips. Chasing the exact Thread/console sdkconfig to
make it build would be endless: Matter, Thread, Zigbee, RainMaker and the ML stack all sit in this
config-sensitive area, and the consumer firmwares use none of them.

Measured on the consumers (`gh search code`, 2026-11-13): `Isonimus/adversary` has zero hits for the
`esp_matter`, `openthread`, `esp_zigbee`, `tflite`, `esp_camera`, and `esp-sr` APIs (the 30 "Matter"
hits are the English word). They are WiFi/BLE/USB pentest firmwares. We should not ship, or even
build, a Matter/Thread/Zigbee/ML stack they never link.

## Decision

Ship only what the consumers use: remove the managed components they never reference, as an overlay
rewrite of the cloned builder's `main/idf_component.yml`, before the version pins. `UPSTREAM.lock`
carries `removedComponents`; `applyOverlay` calls `removeManagedComponents`, which deletes each
named component's whole indented block and fails loud if a named component is absent (a stale
removal must not silently no-op). A removed component is neither downloaded nor built.

`esp_matter` is removed now. This is sufficient and self-contained for two reasons:

- It stops `esp_matter` building, which removes the failure.
- It self-disables arduino-esp32's own Matter library: its sources are guarded by
  `#ifdef CONFIG_ESP_MATTER_ENABLE_DATA_MODEL`, a symbol defined by the `esp_matter` component's
  Kconfig. With the component gone the symbol is undefined, so `Matter.cpp` et al. compile to
  nothing, and the component's `maybe_add_component(espressif__esp_matter)` link guard
  (`IN_LIST components`) skips it. No arduino patch or selective-compilation config is needed.

The builder's `configs/defconfig.common` keeps two now-orphaned Matter lines
(`CONFIG_ENABLE_CHIPOBLE=n`, `CONFIG_ESP_MATTER_NVS_USE_COMPACT_ATTR_STORAGE=y`). IDF treats an
unknown sdkconfig symbol as a warning, not an error, so they are harmless; if a future IDF makes
them fatal, strip them with the same overlay.

This is a new decision, not a supersession. It does narrow ADR-0004: `esp_matter` is no longer
pinned in `managedComponentPins` (you cannot pin a component you do not build), and `esp-tflite-micro`
remains pinned there. ADR-0005's source pins and ADR-0001's stock-builder choice both stand; this
decision is why the stock builder, not Bruce's, is viable despite the config divergence: we drop the
divergent parts the consumers do not need rather than adopt Bruce's config to keep them.

## Consequences

- The esp32/esp32s3 build no longer builds Matter or its OpenThread/connectedhomeip tree. The
  released artifact will not carry Matter libraries. The reference blob does; this is a deliberate
  divergence from the blob's *content*, justified by the consumers not linking it. A consumer that
  later wants Matter must add it back here (and solve the Thread config), not assume parity with the
  old blob.
- The rest of the unused stack (Zigbee via `esp-zboss-lib`/`esp-zigbee-lib`, the RainMaker cluster
  `esp_rainmaker`/`rmaker_common`/`network_provisioning`/`cbor`/`qrcode`/`esp_diag*`/`esp_insights`,
  plus `esp-sr`, `esp-tflite-micro`, `esp32-camera`) still builds. It compiled without error, and
  that cluster is interdependent (declared largely in arduino-esp32's own `idf_component.yml`), so
  removing it is a size optimization that must be done and verified as a unit, not bundled with this
  build fix. It is tracked in `LEDGER.md`.
- `removeManagedComponents` operates on `main/idf_component.yml` only. Components declared in
  arduino-esp32's own manifest (the RainMaker cluster, Zigbee, esp-sr) are out of its reach until
  the overlay also rewrites that file; the follow-up slimming adds that.
- Removing a component the consumers do not use shrinks build time and artifact size, and removes a
  whole class of config-divergence failures rather than fixing them one compile error at a time.
