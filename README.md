# esp32-arduino-adv-libs

A patched ESP-IDF + Arduino-core precompiled libraries build. It publishes release artifacts
shaped exactly like `framework-arduinoespressif32-libs`, so the two sibling pentest firmwares
(`adversary` and `esp32-wifi-sapper`) can retire the third-party precompiled blob they pull today
and pull ours instead, with a one-line `platformio.ini` change.

The *why* (owning the build, fork model, tracking policy, patch conventions, release shape) lives in
[`adr/0001-fork-model-tracking-patch-conventions-release-shape.md`](adr/0001-fork-model-tracking-patch-conventions-release-shape.md).
This file is the *how*: consume a release, and build one.

## Consume a release

Each consumer pins the libs package in `platformio.ini`. Swap the blob URL for a release of this
repo; nothing else changes:

```ini
platform_packages =
    ; before: the third-party Bruce blob
    ; framework-arduinoespressif32-libs @ https://github.com/bmorcelli/esp32-arduino-lib-builder/releases/download/idf-release_v5.5/bruce_esp32-arduino-libs-20251205-131242.zip
    ; after: a release of this repo
    framework-arduinoespressif32-libs @ https://github.com/Isonimus/esp32-adv-libs/releases/download/v0.0.1/adv-esp32-arduino-libs-v5.5-<date>-<sha>.zip
```

The zip's internal layout is a drop-in: the per-chip directories (`esp32/`, `esp32s3/`) sit at the
zip root alongside `package.json`, `tools.json`, and `versions.txt`, which is the shape PlatformIO
expects of the `framework-arduinoespressif32-libs` package. The `v0.0.1` release is an **unmodified**
build (no patches); later releases add one patch each, every patch tracing to a consumer ADR.

## Provenance

Every release carries a `manifest.json` recording the five pins that reconstruct it:

| Pin | Source |
|---|---|
| `upstreamBuilderCommit` | `espressif/esp32-arduino-lib-builder` commit, from `UPSTREAM.lock` |
| `resolvedIdfCommit` | ESP-IDF commit the build actually used, read from `versions.txt` |
| `resolvedArduinoCommit` | Arduino-core commit the build actually used, read from `versions.txt` |
| `patchStackHash` | SHA-256 over the ordered `patches/*.patch`; the empty-stack sentinel for `v0.0.1` |
| `builderImageDigest` | ID of the builder image a release was built in, from the pinned Dockerfile (base pinned by digest). Attests the image used; full bit-reproducibility of the image (pinning its apt/pip layers) is deferred, see `LEDGER.md` |

The release also carries the zip's SHA-256 (`.zip.sha256`). A release that cannot be rebuilt from
those inputs has no provenance guarantee, so the build fails rather than ship one.

## Build locally

The build is a thin overlay: this repo holds only our delta (patch stack, sdkconfig overlay,
orchestration, CI); the heavy work is upstream's, cloned at the pinned commit and built in a
digest-pinned Docker image. Requires Docker, Node.js 20+, git, tar, zip. An IDF build is multi-GB
and roughly an hour per chip.

```sh
# 1. Build our lean builder image (base pinned by digest); records work/image.json.
node scripts/build.mjs image --work work

# 2. Build each enabled chip into dist/ (repeat per chip in UPSTREAM.lock enabledChips).
node scripts/build.mjs chip --work work --image <tag-from-image.json> --chip esp32   --dist dist
node scripts/build.mjs chip --work work --image <tag-from-image.json> --chip esp32s3 --dist dist

# 3. Combine into the Bruce-shaped zip + five-pin manifest.
node scripts/build.mjs package --dist dist --out out --image-digest <id-from-image.json>

# 4. Verify drop-in shape parity, the manifest, and the empty baseline.
node scripts/0002-verify.mjs out/adv-esp32-arduino-libs-*.zip out/manifest.json
```

In CI, [`.github/workflows/release.yml`](.github/workflows/release.yml) runs the same steps as a
matrix (one job per chip, `fail-fast: false`) and publishes the GitHub Release on a `v*` tag. A push
touching the overlay builds every chip and fails whole on any chip failing, but publishes nothing.

## What is pinned where

- [`UPSTREAM.lock`](UPSTREAM.lock): the upstream builder commit, the enabled chip set, the builder
  image base digest, and the reference blob the drop-in check compares against.
- [`reference/bruce-blob-layout.json`](reference/bruce-blob-layout.json): the measured layout of the
  blob the consumers pin today, captured once by `scripts/bruce-blob-shape-probe.mjs` and used as the
  drop-in-parity reference. Regenerate with `npm run probe:bruce-blob`.
- [`patches/`](patches): the ordered patch stack (empty at `v0.0.1`). Each patch is one concern and
  cites the consumer ADR that demands it.
