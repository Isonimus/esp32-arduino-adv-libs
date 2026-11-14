---
id: '0014'
title: "Add the esp32 ESP32_REV_MIN=3 sdkconfig-append overlay, recover IRAM, re-prove the esp32 drop-in"
type: slice
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Goal

Make the `esp32` libs a real drop-in for the consumer firmwares. A `v0.0.1` trial build measured on
2026-11-14 that the stock esp32 build overflows `.iram0.text` by 7272 bytes when adversary `m5stick`
links against it, while the Bruce blob and both `esp32s3` targets link clean (ADR-0013). The cause is
the stock esp32 defconfig taking `CONFIG_ESP32_REV_MIN=0`, which force-enables the PSRAM cache
workaround and relocates a dozen libc groups into IRAM. This slice applies the ADR-0013 decision: the
overlay appends `CONFIG_ESP32_REV_MIN_3=y` to the builder's `configs/defconfig.esp32`, matching the
reference blob (which the consumers already run on), so the workaround drops and IRAM fits. It also
adds the standing invariant that the released esp32 config carries `REV_MIN=3`, and re-runs the esp32
drop-in trial to confirm the overflow is gone.

## Definition of Done

- **Given** the builder's `configs/defconfig.esp32` carrying its stock lines and no `REV_MIN`
- **When** the overlay applies the esp32 defconfig append
- **Then** the file gains exactly the line `CONFIG_ESP32_REV_MIN_3=y`, every stock line is preserved
  byte-for-byte, and a second application (or an upstream that already set the line) fails loud naming
  the line rather than appending a duplicate; an absent target file also fails loud

- **Given** the rebuilt esp32 release artifact
- **When** `scripts/0014-verify.mjs` inspects `esp32/sdkconfig`
- **Then** it resolves `CONFIG_ESP32_REV_MIN=3` and carries no `CONFIG_SPIRAM_CACHE_WORKAROUND=y`,
  exiting non-zero otherwise

- **Given** the rebuilt libs
- **When** both enabled chips build in CI, and adversary `m5stick` (esp32) is re-linked against the
  rebuilt esp32 libs
- **Then** both chips build green, and `m5stick` links with `.iram0.text` fitting `iram0_0_seg` (the
  7272-byte overflow is gone), producing an image

- **Given** the same rebuild
- **When** `esp32s3` builds and its `sdkconfig` is inspected
- **Then** `esp32s3` still builds green and its resolved config is unchanged by this slice (the append
  touches `defconfig.esp32` only; S3 has no PSRAM cache errata, ADR-0013)

## Design

Measured basis and the decision are in ADR-0013. What this slice builds:

- **A defconfig-append overlay helper.** `appendDefconfigLines(text, lines)` in `scripts/build.mjs`
  appends each line to a defconfig fragment, failing loud if the line is already present (upstream
  changed, so our override is redundant or conflicting and must surface, not silently duplicate). It
  is the additive counterpart to `stripDefconfigSymbols` (ADR-0011) and reuses the shared
  `escapeRegExp` (`scripts/lib/regex.mjs`) for the presence test so a `CONFIG_` name with regex
  metacharacters matches literally. `applyOverlay` runs it after the `sdkconfig/` copy and the
  component-symbol strip, against `configs/defconfig.esp32`.
- **Driven by `UPSTREAM.lock`.** A new `addedDefconfigLines` field maps a builder defconfig basename
  to the lines to append: `{ "defconfig.esp32": ["CONFIG_ESP32_REV_MIN_3=y"] }`. The per-file keying
  makes the target explicit and leaves room for a future per-chip addition without a code change.
  `applyOverlay` fails loud if a keyed file is absent.
- **Why append to the per-chip file, not copy one in.** `build.sh` composes `SDKCONFIG_DEFAULTS` with
  `configs/defconfig.$target` in every esp32 build phase (idf-libs, main, bootloader, mem-variant), so
  one appended line covers all phases. Dropping a whole `defconfig.esp32` through the `sdkconfig/`
  copy dir would overwrite upstream's BT, SPIRAM and TWAI-errata lines in that file; an in-place
  append preserves them (ADR-0013).
- **The verify.** `scripts/0014-verify.mjs` reads `esp32/sdkconfig` from the built zip and asserts
  `CONFIG_ESP32_REV_MIN=3` with `CONFIG_SPIRAM_CACHE_WORKAROUND` absent, exit-gating in CI. It mirrors
  `scripts/0012-verify.mjs`'s wired, artifact-inspecting shape.
- **Standing invariant 8** (CLAUDE.md section 4): the released esp32 config resolves `REV_MIN=3`,
  `verified_by: scripts/0014-verify.mjs`.

**Existing code considered.** `stripDefconfigSymbols` and the `escapeRegExp` helper (ADR-0011) are the
model and are reused (the presence regex); the strip removes while this appends, so the helper is new,
not a reshape of the strip. The `sdkconfig/` file-copy overlay was considered and deliberately not
used (it clobbers the whole file). The verify follows `scripts/0012-verify.mjs` and
`scripts/0002-verify.mjs`. The source-pin and manifest-strip injections (ADR-0005, ADR-0011) are a
different seam (build.sh rewrite) and are left untouched.

## Verification

- **Unit** (`test/rev-min-overlay.test.mjs`, run by `npm test`): `appendDefconfigLines` appends the
  named line and only it, preserves the surrounding stock lines, fails loud when the line is already
  present and when asked to append nothing meaningful; the `applyOverlay` wiring fails loud on an
  absent keyed file. Each assertion fails before the helper exists and passes after. Covers DoD
  scenario 1.
- **Post-build integration** (`scripts/0014-verify.mjs`, wired as `verify:revmin` in `package.json`,
  R11): given the built zip, asserts the esp32 `sdkconfig` resolves `REV_MIN=3` and has no cache
  workaround, exiting non-zero otherwise. Its error-gate half runs in CI in the `package` job. Covers
  DoD scenario 2.
- **CI build** (`release.yml`): both chips building green is the build half of DoD scenarios 3 and 4,
  proven by the matrix build the overlay-touching push triggers.
- **esp32 drop-in re-trial** (recorded in `## As built`, like slice-0012's CI-confirmed scenarios):
  adversary `m5stick` re-linked against the rebuilt esp32 libs must link with `.iram0.text` fitting,
  the 7272-byte overflow gone. This needs the consumer firmware tree, so it is a measured result in
  `## As built`, not a wired CI check. Covers DoD scenario 3's link half.
- **S3 untouched** (`scripts/0014-verify.mjs` and the CI build): S3 builds green and the append targets
  `defconfig.esp32` only. Covers DoD scenario 4.

## As built

Filled at merge, in past tense, confirming each Definition-of-Done scenario was met or recording the
deviation. The rebuild-and-retrial result is recorded in an amendment below at merge.

## Amendment: 2026-11-14 Built and hardware-proven

Shipped as designed. The overlay appends `CONFIG_ESP32_REV_MIN_3=y` to `configs/defconfig.esp32` via the
new `addedDefconfigLines` field and the `appendDefconfigLines` helper. Scenario 1 (the overlay append
and its fail-loud guard) was covered by `test/rev-min-overlay.test.mjs` (part of the 86-test suite,
green with lint and the index); an adversarial pass (one Sonnet reviewer, blind to intent) found no
shipping defect, and the guard was hardened at root (CRLF/indent/spaced-equals tolerance, rejecting a
malformed appended line) with before/after tests.

A full local Docker rebuild of both chips off the committed tree confirmed the remaining scenarios:
- Scenario 2 (resolved config): `scripts/0014-verify.mjs` passed on the built zip: `esp32/sdkconfig`
  resolves `CONFIG_ESP32_REV_MIN_3=y` with `CONFIG_SPIRAM_CACHE_WORKAROUND` absent. The same verify was
  first shown to fail on the unfixed v0.0.1 artifact.
- Scenario 3 (drop-in link): adversary `m5stick` (esp32, board esp32-pico-devkitm-2) re-linked against
  the rebuilt esp32 libs built green (RAM 20.9%, Flash 79.4%, ESP32 image created); the 7272-byte
  `.iram0.text` overflow that failed the pre-fix link is gone.
- Scenario 4 (S3 untouched): `esp32s3` built green and the append targets `defconfig.esp32` only.
- Shape parity (`0002`) and slim (`0012`) stayed green on the same artifact.

All Definition-of-Done scenarios are met; the slice is ready to merge.
