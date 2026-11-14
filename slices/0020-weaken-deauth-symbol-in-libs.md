---
id: '0020'
title: "Ship libnet80211.a with the deauth sanity-check symbol weak (patch #1)"
type: slice
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Goal

Deliver roadmap patch #1 (`weak-ieee80211_raw_frame_sanity_check`, release `v0.1.0`): ship
`libnet80211.a` with `ieee80211_raw_frame_sanity_check` as a **weak** symbol on every enabled chip, so
the consumer firmwares (`adversary`, `esp32-wifi-sapper`) can retire the fragile per-build `objcopy`
hook they run today (`adversary:ADR-0027`, `adversary:ADR-0029`). net80211 is a vendored binary blob with
no source, so this is baked in as an in-build symbol-table weakening of the vendored archive, not a
source patch; ADR-0019 records that decision and the narrowing of standing invariant 3 it requires.

## Definition of Done

- **Given** a built release zip,
- **When** `nm` inspects `esp32/lib/libnet80211.a` and `esp32s3/lib/libnet80211.a`,
- **Then** `ieee80211_raw_frame_sanity_check` is weak (`W`) in both, not strong (`T`).

- **Given** a cloned `build.sh` and a `weakenArchiveSymbols` map naming a symbol,
- **When** the overlay injects the weaken step,
- **Then** the injected block resolves an xtensa `objcopy`, guards each archive with an `nm` presence
  check that fails loud if the symbol is absent (so a renamed-upstream symbol cannot silently no-op and
  ship strong), and runs `objcopy --weaken-symbol` on each named archive for each enabled chip.

- **Given** a `build.sh` whose idf-libs anchor is missing or a lock map whose archive/symbol is empty,
- **When** the overlay helper runs,
- **Then** it fails loud (throws) rather than silently producing a build that ships a strong symbol.

- **Given** the `adversary` firmware pinned to this release with its `weaken_deauth` pre-build hook
  disabled,
- **When** `pio run -e cardputer` compiles and links,
- **Then** `deauth.cpp`'s strong override of `ieee80211_raw_frame_sanity_check` links with no
  multiple-definition error (the shipped archive is already weak).

## Design

Measured 2026-11-14 on the shipped `v0.0.2` artifact: `nm` reports
`0000005c T ieee80211_raw_frame_sanity_check` in both `esp32/lib/libnet80211.a` and
`esp32s3/lib/libnet80211.a`. The symbol is a strong definition inside a vendored blob (net80211 is the
closed-source `esp-wifi-lib` submodule; the lib-builder copies the archive verbatim). A source
`__attribute__((weak))` cannot touch a definition already in a `.a`, so the only mechanism is
`objcopy --weaken-symbol` on the archive. ADR-0019 decides to do that once in our build and narrows
invariant 3 to permit a verified vendored-blob weakening while still banning a fragile consumer/post-fetch
rewrite.

**What existing code was considered.** The esp-sr overlay (ADR-0017, `stripEspSrModelStep`) and the
component-slim overlay (ADR-0011) already establish the pattern this reuses: a pure, exported `build.mjs`
helper that rewrites the host-side-cloned `build.sh` and fails loud on a missing anchor, driven by a
single-source-of-truth field in `UPSTREAM.lock`, with a wired `NNNN-verify.mjs` asserting the consequence
on the built zip. This slice adds one more such helper rather than a new mechanism. The `patches/` stack
(git format-patch source diffs) was considered and deliberately **not** used: there is no source diff to
produce, because the target symbol has no source (ADR-0019).

**Mechanism.** A new exported pure helper `injectWeakenArchiveSymbols(buildShText, weakenArchiveSymbols)`
inserts a weaken block into the cloned `build.sh` immediately after the per-target idf-libs anchor
(`idf.py ... -DSDKCONFIG_DEFAULTS="$idf_libs_configs" idf-libs` + its `if [ $? -ne 0 ]; then exit 1; fi`),
which is unique and runs inside the target loop with `$target` and `$AR_TOOLS` in scope. For each
`(archive, symbol)` the generated block: resolves an xtensa `objcopy` once
(`xtensa-esp-elf-objcopy`, falling back to the per-chip prefixed names), fails loud if none; asserts the
archive exists; asserts the symbol is present as a defined `T` or `W` via `nm` (fail loud if absent, the
silent-no-op guard); then runs `objcopy --weaken-symbol`. The weaken runs for every chip the loop visits,
so both enabled chips are covered without a chip list in `build.sh`. `applyOverlay` calls the helper when
`UPSTREAM.lock.weakenArchiveSymbols` is present. The field is a map of archive basename to the list of
symbols to weaken (`{"libnet80211.a": ["ieee80211_raw_frame_sanity_check"]}`), applied to every
`enabledChips` entry.

## Verification

- `test/weaken-archive-symbols.test.mjs` (node:test): unit tests for `injectWeakenArchiveSymbols`:
  inserts the block after the idf-libs anchor; the generated block contains the `nm` presence guard and
  an `objcopy --weaken-symbol` for each named symbol and archive; is identity for an empty/undefined map;
  throws when the idf-libs anchor is absent; throws when a map value is not an array of symbol names.
  This proves the pure, unit-assertable half (Definition of Done scenarios 2 and 3).
- `scripts/0020-verify.mjs` (wired as `verify:weak-deauth` in `package.json`, R11; run in the
  `release.yml` `package` job): given the built release zip, asserts that `nm` on each enabled chip's
  `lib/libnet80211.a` reports every `weakenArchiveSymbols` symbol as weak (`W`) and not strong (`T`), and
  that the archive and symbol are present (non-vacuous). Proves Definition of Done scenario 1 on the real
  artifact, and guards against a rebuild re-introducing a strong symbol (CLAUDE.md section 4 invariant
  11).
- Consumer-link re-trial (manual, Definition of Done scenario 4): build `adversary` `[env:cardputer]`
  against this release with the `weaken_deauth` pre-build hook disabled, and confirm `deauth.cpp`'s
  override links with no multiple-definition error. Artifacts and the measured result are recorded in
  `## As built` at merge. The build is the proof the payoff is delivered; "both chips still build green"
  is the CI matrix.

## As built

Patch #1 shipped as an overlay step, not a `patches/*.patch`: net80211 is a vendored binary blob with no
source (ADR-0019), so `injectWeakenArchiveSymbols` (`scripts/build.mjs`) injects an `objcopy
--weaken-symbol` into the cloned `build.sh` right after each chip's `idf-libs` step, driven by the new
`UPSTREAM.lock` `weakenArchiveSymbols` field (`libnet80211.a` -> `ieee80211_raw_frame_sanity_check`).
The generated bash resolves an xtensa `objcopy`, guards each archive with an `nm` presence check (fail
loud if the symbol is renamed or removed upstream, so it cannot silently no-op and ship strong), then
weakens it; archive basenames and symbol names are validated to safe tokens before interpolation.
`scripts/0020-verify.mjs` (wired `verify:weak-deauth`, CLAUDE.md section 4 invariant 11) asserts `nm` on
the shipped per-chip archive reports the symbol weak. Standing invariant 3 was narrowed in the same
commit (ADR-0019) to admit this verified vendored-blob weakening while still banning the fragile consumer
post-fetch rewrite.

- **Definition of Done scenarios 2 and 3 (overlay + fail-loud):** met locally.
  `test/weaken-archive-symbols.test.mjs` (9 tests) proves the helper inserts the guarded weaken block at
  the idf-libs anchor, handles multiple archives and symbols, and fails loud on a missing anchor, a
  non-array or empty map value, a non-string symbol, a non-identifier symbol, and an unsafe archive
  basename. The helper also anchors byte-for-byte against the real cloned `build.sh` and composes with
  `stripEspSrModelStep`. `npm test` 108 green; `npm run lint` 0 errors / 0 warnings.
- **Scenario 1 (artifact weak):** proven on crafted zips: `0020-verify` fails on the shipped `v0.0.2`
  artifact (symbol `T`, measured `0000005c T` on both chips) and passes on a weakened (`W`) zip, so the
  check bites. Confirmed on the real built artifact by CI in an amendment below.
- **Adversarial pass:** a Sonnet reviewer blind to intent returned a ship verdict (no blockers),
  verifying against the real cached build artifacts that the anchor matches byte-for-byte, that the
  esp32s3 mem-variant phase never re-copies `libnet80211.a` (so no later phase reverts the weakening),
  and that the weaken step is disjoint from `stripEspSrModelStep`. Its two minor notes (unescaped
  interpolation of the symbol and archive) were folded in as the token-validation guard above.

Scenario 1 on the real CI artifact, and scenario 4 (the `adversary` consumer-link re-trial with its
`weaken_deauth` hook disabled), are recorded in amendments below once CI finishes and the board is
flashed.

## Amendment: 2026-11-14 First CI build caught a missing toolchain-prefixed nm

The first build-only CI run (`43647538215`, `workflow_dispatch` on `feat/weak-deauth`, publish skipped)
failed both `chips` legs at the weaken step: `./build.sh: line 244: nm: command not found`, which tripped
the `nm` presence guard's fail-loud path (`ERROR(ADR-0019): ieee80211_raw_frame_sanity_check is not a
defined symbol ...`). Root cause: the IDF build container ships no bare `nm` on PATH, only the
toolchain-prefixed xtensa cross tools. `objcopy` resolution had already succeeded (it resolves
`xtensa-esp-elf-objcopy`), so the fix is symmetric: resolve `weaken_nm` as `xtensa-esp-elf-nm` (falling
back to the per-chip prefix), fail loud if absent, and use `"$weaken_nm"` in the guard. This is the
dependency on the build environment the guard exists to surface, caught before any publish. A unit test
now asserts the generated block resolves a prefixed `nm` and never calls bare `nm`. A second CI build
confirms the fix in a further amendment below.

## Amendment: 2026-11-14 Second CI build confirms the shipped artifact is weak

CI run `43648597057` (build-only `workflow_dispatch` on `feat/weak-deauth`, publish skipped) finished all
six jobs green: `pins`, `prep`, `image`, both `chips` legs, and `package`. The `nm` fix resolved the
first build's failure.

- Scenario 1 (artifact weak), on the real CI artifact: met. The `package` job's `0020-verify` reported
  `esp32/lib/libnet80211.a: ieee80211_raw_frame_sanity_check is weak (W)` and the same for `esp32s3`, so
  the shipped archive carries the symbol weak on both chips (host `nm` on the GitHub runner reads the
  xtensa archives fine).
- Both chips green: met. Injecting the weaken step broke neither build, and the existing verifies
  (`0012`, `0014`, `0016`, `0018`) stayed green (no regression).

Scenario 4 (the `adversary` consumer-link re-trial with its `weaken_deauth` hook disabled) is the only
one outstanding; it is recorded in a further amendment below once the firmware is built and the board
flashed.

## Amendment: 2026-11-14 Consumer-link re-trial confirms DoD scenario 4

The esp32s3 libs from CI run `43648597057` were consumed by the `adversary` firmware with its
`weaken_deauth` pre-build hook **disabled** (so the test proves the shipped libs are weak by
construction, not weakened by the hook) and its `platformio.ini` `framework-arduinoespressif32-libs`
pinned to the built zip (`file://`), the cached libs cleared first.

- Scenario 4 (link): met. `pio run -e cardputer` linked green (`[SUCCESS]`, RAM 25.3%, Flash 75.9% of the
  consumer's 3.34MB app partition), with no multiple-definition error on
  `ieee80211_raw_frame_sanity_check` and the hook confirmed not run. `deauth.cpp`'s strong override links
  because the shipped `libnet80211.a` already carries the symbol weak.
- No regression on hardware: the built image flashed to a PSRAM-less StampS3 Cardputer over
  `/dev/ttyACM0` (hash verified) and booted clean: the `THE ADVERSARY` banner, M5GFX autodetect
  `board_M5CardputerADV`, canvas `Internal: 214200, PSRAM: 0`, `Reset reason: USB (crash count: 0)`, SD
  mounted (SDHC, 292 handshakes), and `Initialization complete. Entering main loop.`; no `abort`, no boot
  loop (the absent WS1850S RFID module logs unrelated I2C errors).

All four Definition-of-Done scenarios are now met. The `adversary` `platformio.ini` edits were temporary
and reverted. The consumers retire their `weaken_deauth` hook on the release carrying this patch (their
`ADR-0027` / `ADR-0029`).
