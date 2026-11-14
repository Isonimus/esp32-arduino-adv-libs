# Changelog

Notable changes, newest first. This is a **hand-maintained** record. When the
project settles into tag-based releases, it can be replaced by a git-tag-generated
changelog.

---

## Unreleased

- **Source-pin reachability preflight.** A CI `pins` job proves every `UPSTREAM.lock`
  `sourcePins` commit is ancestor-reachable from the branch the builder clones, gating the
  `chips` matrix so an unreachable pin fails in seconds instead of at `git checkout` after a
  ~2h build (it cost run `43494803612`). Reachability is tested by ref-ancestry, not
  fetch-by-SHA, which GitHub answers even for unreachable objects (ADR-0009). Adds
  `sourcePinUpstreams` to the lock, `scripts/0010-verify.mjs` (`npm run verify:pins`), and
  CLAUDE.md section 4 invariant 6. Closes the ADR-0005 reachability-gate LEDGER item.
- **Every floating source must be pinned, enforced loud.** A shared `REQUIRED_SOURCE_PINS`
  contract makes both the preflight and `scripts/build.mjs` fail loud when `UPSTREAM.lock`
  drops `arduinoCommit` or `tinyusbCommit`, instead of silently cloning floating `master`
  heads (the ADR-0005 drift). Found by slice-0010's adversarial review.

---

## v0.0.1 (2026-11-13)

First tagged release: the unmodified baseline. Repo bootstrap plus the build fixes that got
both chips green. Patched ESP-IDF 5.5 + Arduino-core precompiled libs, shaped like
`framework-arduinoespressif32-libs`, built and published for `esp32` and `esp32s3` with no
patches applied (release run `43526028879`, tag `v0.0.1`). The release carries the zip, its
SHA-256, and the five-pin provenance manifest.

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
- **tinyusb re-pinned to the stock builder's era (ADR-0008).** With C++20 in place, esp32
  built fully green and esp32s3 reached `arduino_tinyusb/src/dcd_dwc2.c`, failing with
  `'dwc2_regs_t' has no member named 'ghwcfg2_bm'` and `conflicting types for
  'dcd_edpt_xfer'`. That driver is vendored by the lib-builder and compiled against the
  tinyusb it clones; ADR-0005 had pinned tinyusb to the blob's 2025-12-05 commit
  (`93b53158`), whose upstream had since dropped the DWC2 `_bm` register API the builder's
  Jan-2025 vendored driver uses. The blob's snapshot is coherent with the blob's own builder
  fork, not with the stock espressif builder we build on. `tinyusbCommit` is now
  `91214b46` (tinyusb master at the builder's own commit date), what the stock builder would
  itself have cloned. This refines ADR-0005's tinyusb value (a source pin's anchor is the
  stock builder's era, not the blob's); the IDF and arduino pins already matched the builder.
- **Manifest parser fixed to the builder's real `versions.txt` format.** With both chips
  green for the first time (run `43517943974`), the `package` step failed resolving the
  provenance commits: `could not resolve idf/arduino commits from esp32 versions.txt`. The
  stock builder writes one short commit per line (`esp-idf: 8410210c9a0`), but
  `parseVersionsText` assumed a two-token `<name>: <branch> <sha>` line and captured the
  second token, so it matched nothing. The regex (and its test fixtures, previously green
  against an invented format) now match a hex SHA immediately after the label, failing loud
  on any other shape so a branch name can never be recorded as a provenance commit. The whole
  `package` + Scenario A/C/D verify was replayed locally against the real chip artifacts.
- **Managed-component versions pinned (ADR-0004).** Upstream declares
  `esp-tflite-micro` (and camera/sr/matter) as floating minimums, so the component
  manager resolved a newer `esp-tflite-micro` that broke the build by forcing
  `-std=c++11` on its own C++17 code. `UPSTREAM.lock` now carries
  `managedComponentPins`, applied to the cloned builder's `main/idf_component.yml`
  before build; `esp-tflite-micro` is pinned to `==1.3.5`, the version inside the
  reference blob the consumers run today. The other floating components remain
  tracked in the ledger.

The pipeline is now proven: the `v0.0.1` tag built green across both chips and
published the Release, so standing invariants 4 and 5 moved from `pending (LEDGER)`
to `verified_by` and the ledger's deferral closed.
