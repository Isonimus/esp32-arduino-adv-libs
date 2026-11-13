# Changelog

Notable changes, newest first. This is a **hand-maintained** record. When the
project settles into tag-based releases, it can be replaced by a git-tag-generated
changelog.

---

## Unreleased

Repo bootstrap. No release has been tagged yet; `v0.0.1` will be the first.

- **Thin-overlay builder fork established.** The repo owns a patched ESP-IDF 5.5 +
  Arduino-core precompiled-libs build as a thin overlay over
  `espressif/esp32-arduino-lib-builder`, pinned at commit `e68e301` (ADR-0001). It
  holds only our delta; the heavy build is upstream's, run in a digest-pinned
  Docker image in CI.
- **slice-0002 overlay landed, unproven.** `UPSTREAM.lock` (five-pin inputs),
  `scripts/build.mjs` (image/chip/package), `.github/workflows/release.yml` (the
  matrix gate), and `scripts/0002-verify.mjs` (drop-in shape parity against the
  measured Bruce-blob layout). No patches are applied: `v0.0.1` is the unmodified
  baseline the patch stack later builds on.
- **Doc method and quality bar vendored.** The stele method (immutable ADRs and
  slices, one mutable `LEDGER.md`, a zero-dependency linter, index builder, and
  pre-commit hook) and a `node:test` suite guarding the build helpers.
- **Repo infrastructure added.** License, code of conduct, contributing and
  security policies, issue and PR templates, Dependabot, a lint/test CI workflow,
  and CodeQL scanning.
- **ADR-index cell escaping hardened.** `scripts/build-index.mjs` now escapes the
  backslash before the pipe, so a title carrying either character cannot corrupt
  the generated table (CWE-116, first CodeQL finding); covered by a regression test.
- **IDF version now selected explicitly (ADR-0003).** The first heavy CI build
  revealed the upstream builder defaults to ESP-IDF `release/v5.3`, so the overlay
  was silently building 5.3, not the 5.5 the consumers need. `UPSTREAM.lock` gains
  `upstream.idfBranch` (`release/v5.5`), passed to `build.sh -I`; the build fails
  loud if it is absent. Also fixed the container `safe.directory` so in-container
  git works on the runner-owned mount.
- **All floating build inputs pinned to one snapshot (ADR-0005).** The builder
  also clones ESP-IDF, arduino-esp32, and tinyusb at floating branch heads, which
  drift apart and broke both chips (tinyusb master dropped a file the pinned CMake
  lists; arduino master needed an esp_matter header its floating range lacked).
  `UPSTREAM.lock` now carries `sourcePins` fixing all three to the exact commits
  of that snapshot (IDF via `build.sh -i`, arduino and tinyusb via force-checkouts
  the overlay injects into `build.sh`), and `esp_matter` is pinned to `1.4.1`. Each
  pin must be reachable from a clonable ref on its upstream; arduino is pinned to the
  espressif-upstream base commit the blob compiled from (`9b3364c6`), not the blob's
  own downstream-fork wrapper SHA, which is byte-identical in source but unreachable
  from any espressif ref (ADR-0005, incl. its 2026-11-13 amendment). This supersedes
  ADR-0003's float-the-branch choice.
- **Unused managed components removed, starting with esp_matter (ADR-0006).** With the source
  pins fixed, the build reached a deep compile failure on both chips: `esp_matter`'s OpenThread
  console (`esp_matter_console_otcli.cpp`) needs a Thread config that is off on esp32/esp32s3. The
  reference blob built it only because it used bruce's lib-builder fork config, not espressif's
  stock one. The consumer firmwares use no Matter/Thread/Zigbee/ML APIs, so rather than adopt
  Bruce's config, the overlay now removes components the consumers never use from the builder's
  `main/idf_component.yml` (`removedComponents` in `UPSTREAM.lock`, applied by
  `removeManagedComponents`). Removing `esp_matter` also self-disables arduino-esp32's Matter
  library, which is guarded by `CONFIG_ESP_MATTER_ENABLE_DATA_MODEL`. `esp_matter` is no longer in
  `managedComponentPins`. The rest of the unused stack still builds and is tracked for a follow-up
  slimming in the ledger.
- **Builder C++ standard bumped to C++20 (ADR-0007).** With the components right, the build reached
  the real compile and failed on both chips with the same error class: `emplace_back(a, b)` on a
  braceless-aggregate struct (`HTTPClient::RequestArgument` on esp32, `esp-dl`'s `img_s` on esp32s3),
  which is legal only from C++20 (P0960). The builder's `idf-release_v5.5` branch forces the whole
  project to `-std=gnu++17` (appended after IDF 5.5's own `-std=gnu++2b`, so it wins) via its root
  `CMakeLists.txt`, while the arduino master base we pin (ADR-0005) needs C++20. Espressif's own
  builder master already carries `-std=gnu++2a` on that line; the overlay now rewrites the cloned
  builder's `CMakeLists.txt` to match (`builderCxxStandard` in `UPSTREAM.lock`, applied by
  `setBuilderCxxStandard`, fail-loud if the expected flag is absent).
- **Managed-component versions pinned (ADR-0004).** Upstream declares
  `esp-tflite-micro` (and camera/sr/matter) as floating minimums, so the component
  manager resolved a newer `esp-tflite-micro` that broke the build by forcing
  `-std=c++11` on its own C++17 code. `UPSTREAM.lock` now carries
  `managedComponentPins`, applied to the cloned builder's `main/idf_component.yml`
  before build; `esp-tflite-micro` is pinned to `==1.3.5`, the version inside the
  reference blob the consumers run today. The other floating components remain
  tracked in the ledger.

The CI build and the `v0.0.1` tag are intentionally unproven at bootstrap:
standing invariants 4 and 5 stay pending in `LEDGER.md` until a tagged build is
green.
