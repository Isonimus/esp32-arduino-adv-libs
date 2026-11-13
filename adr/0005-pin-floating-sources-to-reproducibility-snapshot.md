---
id: '0005'
title: "Pin every floating build input to an exact commit, not a branch head"
type: architecture
status: accepted
date: 2026-11-13
supersedes: ['0003']
superseded_by: []
---

## Context

ADR-0003 got the build onto ESP-IDF 5.5 by passing `build.sh -I release/v5.5`, and ADR-0004
pinned the `esp-tflite-micro` managed component. ADR-0003 deliberately kept ADR-0001's
"measure, don't pin" stance: it selected the IDF *branch* and let the resolved commit float,
recorded per-build in the manifest. The next builds proved that stance wrong.

With 5.5 selected and tflite pinned, both chips still failed, each on a *different* floating
input:

- **esp32s3**: the builder clones `tinyusb` from `hathach/tinyusb` at branch `master`
  (`tools/update-components.sh`, unpinned). Today's master has removed
  `src/device/usbd_control.c`, which the builder's pinned `components/arduino_tinyusb/
  CMakeLists.txt:66` still lists, so CMake fails at configure: `Cannot find source file`.
- **esp32**: the builder clones `arduino-esp32` at `master` (`tools/install-arduino.sh`,
  unpinned). Today's master has a `libraries/Matter/src/matter_closure_patch.h` that includes an
  `esp_matter` header absent from the floating `esp_matter ^1.3.0` it resolved, so the compile
  fails: `fatal error: app/clusters/closure-control-server/closure-control-cluster-objects.h: No
  such file`.

The pattern is the point: the upstream builder floats *every* input (the IDF branch head, the
arduino-esp32 branch head, `tinyusb@master`, and the `esp_matter`/`esp-sr`/`esp-camera` version
ranges). They are only mutually consistent at the instant Espressif's CI cuts a release. Selecting
a branch (ADR-0003) tracks a head that moves out from under the rest of the pinned tree. Only
pinning an exact, mutually-consistent set of commits makes the build reproducible instead of
dependent on the calendar.

A known-good consistent set already exists: the reference blob both consumers pin today. Its
`versions.txt`, read on 2026-11-13 from the 2025-12-05 build, records the exact commits, all
confirmed present in the upstream (non-Bruce) repos we build from:

| Input | Pin | Upstream repo |
|---|---|---|
| ESP-IDF | `8410210c9a0427be9655a855ddfa3dc9c38a6aad` (on `release/v5.5`, 2025-11-06) | `espressif/esp-idf` |
| arduino-esp32 | `32709d56deb6030b2aa16a456a8c7c1c9e20a7e9` (2025-12-05) | `espressif/arduino-esp32` |
| tinyusb | `93b53158f02bce9497419298ac27150eebe567d3` (2025-12-05) | `hathach/tinyusb` |
| esp-tflite-micro | `1.3.5` | registry (ADR-0004) |
| esp_matter | `1.4.1` | registry |

## Decision

Pin every floating source to an exact commit, recorded in `UPSTREAM.lock`:

- **ESP-IDF** (`sourcePins.idfCommit`): passed as `build.sh -i <commit>` on top of the `-I
  release/v5.5` clone branch. `-I` still selects which branch to clone (the builder defaults to
  5.3 without it, ADR-0003); `-i` then checks out the exact commit on it.
- **arduino-esp32 and tinyusb** (`sourcePins.arduinoCommit`, `sourcePins.tinyusbCommit`): neither
  `install-arduino.sh` nor `update-components.sh` accepts a commit (arduino takes a branch and then
  `git pull --ff-only`, which breaks on a detached head; tinyusb is hard-coded to master). So
  `applyOverlay` injects `git checkout <commit>` for each, into `build.sh` right after those clones
  run. The clones are full, so any ancestor commit is reachable. `pinBuildSources` performs the
  injection and fails loud if the anchor is gone, so an upstream layout change cannot silently skip
  pinning.
- **esp_matter** (`managedComponentPins`): pinned to `1.4.1` by the ADR-0004 mechanism. 1.4.1 is
  what the pinned arduino commit's Matter library needs; the floating range resolved lower and was
  the esp32 failure.

This **supersedes ADR-0003**. ADR-0003's reasoning, that keeping ADR-0001's measure-don't-pin
model was worth a floating branch, was wrong: a floating branch is not a provenance anchor, it is a
time bomb that the manifest faithfully records *after* it has already changed the output. The
resolved commits are still written into the manifest (that remains useful as an as-built record),
but the lock now *fixes* them rather than merely observing them. ADR-0003's other content (the `-I`
branch selection, the `safe.directory` fix) stands; this ADR keeps the `-I` flag and adds `-i`.

Exact commits, not ranges or branches, for the same reason ADR-0004 chose `==`: reproducibility is
the whole point, and anything looser reintroduces the drift this ADR removes.

## Consequences

- The build is now reconstructable from the lock: five source pins (IDF/arduino/tinyusb commits
  plus the two component versions) plus the builder commit. This is what ADR-0001 section 5's
  "reconstructable from the recorded pins" always needed to mean; §4 invariant 5 can cite it once a
  build is green.
- `esp32-camera` (floating `master`) and `esp-sr` are still unpinned. Neither has broken a build
  yet (esp-sr resolved 2.6.2 and compiled; camera is skipped for these targets), but they are the
  same latent risk. The LEDGER item is narrowed to them; pinning them is the same two mechanisms
  applied again, and the blob's `versions.txt` has esp-camera's commit when needed.
- Transitive managed components (esp-dsp, esp-modbus, the rmaker tree, and the rest the component
  manager pulls under esp_matter and arduino) are still resolved by the manager, not pinned here.
  The manager writes a `dependencies.lock` during the build that records them; committing that lock
  for full transitive reproducibility is the remaining component-locking work, tracked in LEDGER.
- Pinning arduino and tinyusb by injecting into `build.sh` couples us to that anchor text; the
  injection fails loud if upstream moves it, so the coupling surfaces at build time, not silently.
