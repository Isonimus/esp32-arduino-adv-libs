---
id: '0004'
title: "Managed-component versions are pinned in the lock, not resolved floating at build time"
type: architecture
status: accepted
date: 2026-11-13
supersedes: []
superseded_by: []
---

## Context

ADR-0003 got the build onto the correct ESP-IDF (`release/v5.5`). The next run then failed
compiling the `esp-tflite-micro` managed component: its CMake appends `-std=c++11` after IDF's
`-std=gnu++17`, and the last `-std` wins in g++, so its own C++17 code (`if constexpr`,
`std::is_integral_v`, `common_type_t`) does not compile. The LEDGER item opened against ADR-0003
named this: managed components are pulled unpinned, so a registry update can break or change a
build the five pins claim is reconstructable.

The upstream builder declares its heavy dependencies as floating minimums in
`main/idf_component.yml`: `espressif/esp-tflite-micro: ">=1.2.0"`, `espressif/esp32-camera:
"master"`, `espressif/esp-sr: ">=1.4.2"`, `espressif/esp_matter`. The IDF component manager
resolves these to "latest satisfying" at build time, so the same commit of this repo produces a
different, and now unbuildable, tree depending only on the calendar.

Checked whether the consumers' reference build protects against this: it does not. Measured
2026-11-13, `bmorcelli/esp32-arduino-lib-builder` (the Bruce fork whose blob both consumers pin
today) declares `esp-tflite-micro` as the identical `">=1.2.0"` floating minimum, with no upper
bound and no lock. Its successful 2025-12-05 build succeeded only because of what the registry
served that day. There is no upstream precedent to copy.

The registry version history of `esp-tflite-micro`, measured from
`components.espressif.com/api/components/espressif/esp-tflite-micro` on 2026-11-13:

| Version | Released | Note |
|---|---|---|
| 1.4.3 | 2026-11-10 | current "latest" that `">=1.2.0"` now resolves to; breaks the build |
| 1.4.2 … 1.3.7 | 2026 | all released after the reference blob |
| **1.3.5** | **2025-11-17** | latest at the 2025-12-05 blob build, so the version inside the blob consumers run today |

## Decision

Pin managed-component versions in `UPSTREAM.lock` (`managedComponentPins`), and apply them to the
cloned builder's `main/idf_component.yml` before building. `scripts/build.mjs` does this in
`applyOverlay` via `pinComponentVersions`, a pure line-rewrite that replaces only the targeted
component's `version:` line and fails loud if a pinned component, or its version line, is absent,
so a stale pin cannot silently no-op.

`esp-tflite-micro` is pinned to `==1.3.5`: the version the reference blob was built with, chosen
for parity with what the consumers already run and because its older code is far likelier to
compile under the current GCC 14.4 toolchain than the 1.4.x line that broke.

The pin is applied as a manifest rewrite, deliberately **not** as a numbered entry in the
`patches/` stack. The patch stack is reserved for source patches that each cite a consuming ADR
(ADR-0001 invariant 2); a build-config version pin is neither a source change nor consumer-driven,
so folding it into that stack would break the "one patch, one consumer concern" contract. It
belongs with the other build inputs in the lock, alongside `idfBranch` (ADR-0003), applied by the
same overlay step as the sdkconfig overlay.

Exact version (`==1.3.5`), not a range, because the whole point is reproducibility: a range
reintroduces the floating resolution this ADR exists to remove.

## Consequences

- This pins `esp-tflite-micro` only. `esp32-camera` (floating `master`), `esp-sr`, and `esp_matter`
  are still unpinned, so the reproducibility gap is narrowed, not closed. The LEDGER item (ADR-0003)
  is narrowed to those remaining components; pinning them is the same mechanism applied again, once
  a build proves which versions the 5.5 tree needs.
- `1.3.5` is a bet that it compiles under GCC 14.4; the reference blob used an older toolchain. If
  it still fails, the fallback is a newer pin plus a targeted `-std` patch, or dropping the
  component (neither consumer links it: verified 2026-11-13, no `tflite`/`tensorflow`/`esp_nn`
  references in `adversary` or `esp32-wifi-sapper`). That decision, if forced, gets its own ADR.
- The exact resolved component set still wants capturing in the release manifest for full
  provenance (the build's generated `dependencies.lock` records it). That is part of the remaining
  component-locking work, not done here.
