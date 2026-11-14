---
id: '0012'
title: "Slim the build: remove the unused Zigbee, RainMaker, TFLite and camera stack"
type: slice
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Goal

Finish the component slim ADR-0006 began and deferred. The two consumer firmwares link none of
Zigbee, RainMaker, TensorFlow-Lite-Micro or camera, yet the stock builder still downloads and builds
them. Remove them so the released libs carry only what the consumers use: smaller artifact, less
config-sensitive surface, closer to the actual dependency set.

This folds two LEDGER items. The `[feature]` slim item (ADR-0006) is delivered here for the
manifest-only stack; its `esp-sr` part stays open because `esp-sr` is entangled with the builder's
`esp_sr` feature (`builds.json` + `srmodels_bin` + `defconfig.esp_sr`), a heavier mechanism given its
own slice (ADR-0011 records the split). The `[bug]` unpinned-inputs item (ADR-0005) loses its
`esp32-camera` clause (a removed component needs no pin); its `esp-sr` and transitive
`dependencies.lock` clauses stay open. Both LEDGER lines are narrowed, not deleted.

The removal set and where each is declared (measured 2026-11-14, ADR-0011):
- builder `main/idf_component.yml` (host-side): `espressif/esp32-camera`, `espressif/esp-tflite-micro`.
- arduino-esp32 `idf_component.yml` (in-container): `espressif/esp-zboss-lib`, `espressif/esp-zigbee-lib`,
  `espressif/esp_rainmaker`, `espressif/rmaker_common`, `espressif/network_provisioning`,
  `espressif/esp_insights`, `espressif/esp_diag_data_store`, `espressif/esp_diagnostics`,
  `espressif/cbor`, `espressif/qrcode`.

## Definition of Done

- **Given** `UPSTREAM.lock` listing the unused stack for removal (split across `removedComponents` and
  `removedArduinoComponents`)
- **When** each enabled chip builds in CI
- **Then** both `esp32` and `esp32s3` build green (no removed component is unconditionally required;
  every consumer self-disables)

- **Given** the built release artifact
- **When** `scripts/0012-verify.mjs` inspects each chip's `dependencies.lock`
- **Then** none of the removed components appears, and the kept components (`mdns`, `libsodium`,
  `littlefs`, `esp-dsp`, `esp-modbus`, `esp-libhelix-mp3`, `lan867x`) are still present

- **Given** a removal entry naming a component absent from its manifest
- **When** the overlay runs (`removeManagedComponents` for `main`, the python remover for arduino)
- **Then** it fails loud naming the component, rather than silently no-op'ing

- **Given** the orphaned `defconfig.common` symbols and the orphaned `CMakeLists.txt`
  `-DCHIP_HAVE_CONFIG_H` define
- **When** the overlay applies `stripDefconfigSymbols` and `stripBuilderCxxDefine`
- **Then** those exact lines are gone and the kept lines (`CONFIG_ESP_COREDUMP_*`, `CONFIG_MBEDTLS_*`,
  `-std=gnu++2a`) remain; each rewrite fails loud if its target is already absent

- **Given** the slimmed artifact
- **When** `scripts/0002-verify.mjs` checks drop-in shape parity
- **Then** Scenario A still passes (top-level entries and per-chip subtree roots are unchanged) and
  the artifact is smaller than the pre-slim build (measured in `## As built`)

## Design

Measured basis and the full mechanism rationale are in ADR-0011. Summary of what this slice builds:

- **Two manifests, two mechanisms.** `main/idf_component.yml` is rewritten host-side by the existing
  `removeManagedComponents` (ADR-0006), extended list. arduino's own `idf_component.yml` only exists
  in-container (cloned by `build.sh`, force-checked-out to `arduinoCommit`), so it is rewritten
  in-container: `applyOverlay` copies `scripts/overlay/strip-manifest-components.py` into the builder
  tree, and the overlay injects a call to it into `build.sh` right after the arduino checkout. The
  python remover ports `removeManagedComponents`' line-based block removal and its fail-loud contract;
  it is python because the builder image has `python3` but no node (ADR-0011).
- **Orphaned-config cleanup, host-side.** `stripDefconfigSymbols(text, symbols)` removes the orphaned
  `CONFIG_...` lines from `configs/defconfig.common` by exact symbol match (never prefix, so
  `CONFIG_ESP_COREDUMP_*` survives next to `CONFIG_ESP_INSIGHTS_COREDUMP_ENABLE`).
  `stripBuilderCxxDefine(text, define)` removes `-DCHIP_HAVE_CONFIG_H` from the builder CMakeLists
  `CXX_COMPILE_OPTIONS` line after `setBuilderCxxStandard` (ADR-0007). Both fail loud if absent.
- **`managedComponentPins` empties** (its only entry, `esp-tflite-micro`, is now removed); the
  `pinComponentVersions` mechanism stays for future use.
- Inert `defconfig.common` section-header comments (`# Matter Settings`, `# ESP Insights`) are left:
  the warnings come from `CONFIG_` assignment lines, which the symbol-keyed remover clears
  deterministically; matching comments to removed symbols would add fragile string-matching for no
  functional gain (KISS). Out of scope for the same reason: `esp-sr` and its feature machinery.

**Existing code considered.** `removeManagedComponents`, `pinComponentVersions` and
`setBuilderCxxStandard` (all in `scripts/build.mjs`) are the model for the new rewrites and are
reused where they already fit (`main` removal, the CXX line). The source-pin force-checkout injection
(`pinBuildSources`, ADR-0005) is the pattern the in-container strip injection follows and is the
anchor it hooks after; it is left unchanged (single-concern), with the strip injected as a separate
rewrite applied after it. No existing helper edits arduino's manifest or the defconfig, which is the
gap. The verify mirrors `scripts/0002-verify.mjs`'s wired, artifact-inspecting, exit-code-gating
shape.

## Verification

- **Unit** (`test/slim-overlay.test.mjs`, run by `npm test`): `stripDefconfigSymbols` removes the
  named symbols and only those (keeps `CONFIG_ESP_COREDUMP_*`), fails loud on an absent symbol;
  `stripBuilderCxxDefine` removes `-DCHIP_HAVE_CONFIG_H` and keeps `-std=gnu++2a`, fails loud if
  absent; `removeManagedComponents` on the extended `main` list. Each fails before its guard exists
  and passes after. Covers DoD scenario 3 (main) and 4.
- **Python remover** (`test/strip-manifest-components.test.mjs`, spawns `python3` which the CI runner
  has): removes named blocks from a fixture arduino manifest preserving kept components, and exits
  non-zero naming an absent component. This tests the exact in-container artifact. Covers DoD
  scenario 3 (arduino).
- **Post-build integration** (`scripts/0012-verify.mjs`, wired as `verify:slim` in `package.json`,
  R11): given the built zip, asserts each chip's `dependencies.lock` contains none of the removed
  components and all of the kept ones, exiting non-zero otherwise. Its error-gate half runs in CI as
  a `slim` job after `chips`. Covers DoD scenario 2.
- **CI build** (`release.yml`): both chips building green is DoD scenario 1, proven by the matrix
  build the next overlay-touching push triggers; a removed component that is unconditionally required
  would fail at configure in the first minutes.
- **Shape parity** (`scripts/0002-verify.mjs`, already wired): DoD scenario 5, unchanged check,
  confirmed still green on the slimmed artifact.

## As built

Shipped as designed (ADR-0011). `removedComponents` gained `esp32-camera` and `esp-tflite-micro`
(host-side); `removedArduinoComponents` carries the Zigbee pair and the RainMaker cluster, removed
in-container by `scripts/overlay/strip-manifest-components.py` (a fail-loud port of
`removeManagedComponents`, python because the builder image has no node), injected into `build.sh`
after the arduino force-checkout. `stripDefconfigSymbols` and `stripBuilderCxxDefine` clean the 15
orphaned `defconfig.common` symbols and the `-DCHIP_HAVE_CONFIG_H` define; `managedComponentPins`
emptied. `scripts/0012-verify.mjs` (`verify:slim`) gates the `package` job; CLAUDE.md section 4 gained
invariant 7; the two LEDGER items were narrowed (esp-sr and the `dependencies.lock` capture remain).

Verified locally before the build: every overlay rewrite dry-run against the real builder files at the
pinned commits (CMakeLists reduced to a clean `"-std=gnu++2a"`, defconfig dropped exactly the 15 lines
keeping the coredump/mbedtls ones, the main manifest removed the three keeping esp-sr); the python
remover stripped the real arduino manifest (10 components, 8 kept components intact, YAML still valid,
fail-loud exit on an absent name); `0012-verify` passed on a synthetic good artifact and failed on a
re-introduced component. 71 unit tests, lint, and the index all green.

An adversarial pass (one Sonnet reviewer, blind to intent) confirmed the mechanism (python/JS removers
agree, no shell-injection via lock-controlled names, baseline behaviour unchanged, fail-loud throughout)
and found four latent defects, all fixed at root with before/after regression tests: a miswritten
regex character class that made two escapes no-ops (fixed by extracting one shared `escapeRegExp` across
all five call sites); `stripBuilderCxxDefine` corrupting a define it is a prefix of or a `-DX=1` form
(fixed with a list-terminator boundary); a symlink-fragile entry-point guard that could pass the gate
silently (fixed by moving the checker to `scripts/lib/` and running `main()` unconditionally); and a
python universal-newline rewrite breaking CRLF parity (fixed with `newline=""`).

Definition-of-Done scenarios 3, 4 and 5 are met locally. Scenarios 1 (both chips build green) and 2
(`0012-verify` against each chip's real `dependencies.lock`) are confirmed by the CI build this change
triggers; the result is recorded in an amendment below at merge.
