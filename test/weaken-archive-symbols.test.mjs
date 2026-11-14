// Regression tests for the host-side overlay rewrite behind patch #1 (slice-0020, ADR-0019):
// injectWeakenArchiveSymbols inserts an in-build `objcopy --weaken-symbol` step into the cloned build.sh,
// right after the per-target idf-libs step, so the shipped libnet80211.a ships with
// ieee80211_raw_frame_sanity_check weak. The weak symbol in the shipped artifact is proven separately by
// scripts/0020-verify.mjs on the built zip. These cover the pure, unit-assertable half: the rewrite
// inserts exactly its guarded weaken block at the right anchor, and fails loud rather than silently
// no-op'ing when the anchor or the config is wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectWeakenArchiveSymbols } from '../scripts/build.mjs';

// A fragment shaped like the esp32s3 idf-libs region of build.sh: the per-target idf-libs build with its
// error check (the anchor), then the next section. Exactly the pinned-builder layout (4-space indent).
const BUILD_SH = [
  '    echo "* Build IDF-Libs: $idf_libs_configs"',
  '    rm -rf build sdkconfig',
  '    idf.py -DIDF_TARGET="$target" -DSDKCONFIG_DEFAULTS="$idf_libs_configs" idf-libs',
  '    if [ $? -ne 0 ]; then exit 1; fi',
  '',
  '    # Build Bootloaders',
  '    for boot_conf in `echo "$target_json" | jq -c \'.bootloaders[]\'`; do',
  '',
].join('\n');

const ONE = { 'libnet80211.a': ['ieee80211_raw_frame_sanity_check'] };

test('injectWeakenArchiveSymbols inserts the weaken block right after the idf-libs anchor', () => {
  const out = injectWeakenArchiveSymbols(BUILD_SH, ONE);
  // The anchor and the following section both survive, in order, with the block between them.
  const anchorEnd = '    if [ $? -ne 0 ]; then exit 1; fi\n';
  const idxAnchor = out.indexOf(anchorEnd);
  const idxWeaken = out.indexOf('# Weaken vendored-blob archive symbols');
  const idxNext = out.indexOf('# Build Bootloaders');
  assert.ok(idxAnchor !== -1, 'anchor kept');
  assert.ok(idxWeaken > idxAnchor, 'weaken block inserted after the anchor');
  assert.ok(idxNext > idxWeaken, 'the next section survives after the weaken block');
});

test('the generated block resolves an xtensa objcopy and guards + weakens each named symbol', () => {
  const out = injectWeakenArchiveSymbols(BUILD_SH, ONE);
  assert.ok(out.includes('weaken_objcopy=$(command -v xtensa-esp-elf-objcopy'), 'resolves objcopy');
  // The IDF container has no bare nm/objcopy; both must be toolchain-prefixed cross tools.
  assert.ok(out.includes('weaken_nm=$(command -v xtensa-esp-elf-nm'), 'resolves a toolchain-prefixed nm, not bare nm');
  assert.ok(!out.includes('    if ! nm "$weaken_lib"'), 'does not call bare nm (absent in the build container)');
  assert.ok(out.includes('weaken_lib="$AR_TOOLS/esp32-arduino-libs/$target/lib/libnet80211.a"'), 'targets the per-chip archive');
  // The nm presence guard: a symbol renamed/removed upstream must fail loud, not let objcopy no-op.
  assert.ok(out.includes("\"$weaken_nm\" \"$weaken_lib\" | grep -qE ' [TW] ieee80211_raw_frame_sanity_check$'"), 'nm presence guard present');
  assert.ok(out.includes('"$weaken_objcopy" --weaken-symbol=ieee80211_raw_frame_sanity_check "$weaken_lib"'), 'runs the weaken');
});

test('injectWeakenArchiveSymbols handles several archives and several symbols', () => {
  const out = injectWeakenArchiveSymbols(BUILD_SH, {
    'libnet80211.a': ['ieee80211_raw_frame_sanity_check', 'another_sym'],
    'libpp.a': ['pp_sym'],
  });
  for (const archive of ['libnet80211.a', 'libpp.a']) {
    assert.ok(out.includes(`lib/${archive}"`), `weakens ${archive}`);
  }
  for (const sym of ['ieee80211_raw_frame_sanity_check', 'another_sym', 'pp_sym']) {
    assert.ok(out.includes(`--weaken-symbol=${sym} `), `weakens ${sym}`);
  }
});

test('injectWeakenArchiveSymbols is identity for an empty or undefined map', () => {
  assert.equal(injectWeakenArchiveSymbols(BUILD_SH, {}), BUILD_SH);
  assert.equal(injectWeakenArchiveSymbols(BUILD_SH, undefined), BUILD_SH);
});

test('injectWeakenArchiveSymbols fails loud when the idf-libs anchor is absent', () => {
  // Upstream reshaped the idf-libs step: the strip must surface rather than silently produce a build that
  // ships a strong symbol.
  const noAnchor = [
    '    echo "* Build IDF-Libs"',
    '    idf.py -DIDF_TARGET="$target" build-something-else',
    '    # Build Bootloaders',
  ].join('\n');
  assert.throws(() => injectWeakenArchiveSymbols(noAnchor, ONE), /idf-libs anchor not found/);
});

test('injectWeakenArchiveSymbols fails loud when a map value is not a non-empty array', () => {
  assert.throws(() => injectWeakenArchiveSymbols(BUILD_SH, { 'libnet80211.a': 'ieee80211_raw_frame_sanity_check' }), /must be a non-empty array/);
  assert.throws(() => injectWeakenArchiveSymbols(BUILD_SH, { 'libnet80211.a': [] }), /must be a non-empty array/);
});

test('injectWeakenArchiveSymbols fails loud on a non-string symbol', () => {
  assert.throws(() => injectWeakenArchiveSymbols(BUILD_SH, { 'libnet80211.a': [42] }), /non-string symbol/);
});

test('injectWeakenArchiveSymbols rejects a symbol that is not a C identifier', () => {
  // The symbol is interpolated into an objcopy argument and a grep -qE pattern; a regex/shell
  // metacharacter must be refused, not emitted into generated bash.
  for (const bad of ['foo$(rm -rf /)', 'foo bar', 'foo.bar', 'foo*', '1foo']) {
    assert.throws(() => injectWeakenArchiveSymbols(BUILD_SH, { 'libnet80211.a': [bad] }), /not a valid C identifier/, `rejects ${bad}`);
  }
});

test('injectWeakenArchiveSymbols rejects an unsafe archive basename', () => {
  // The archive name is interpolated into a shell path; a slash or metacharacter must be refused.
  for (const bad of ['../lib/x.a', 'lib net.a', 'lib$(x).a', 'a/b.a']) {
    assert.throws(() => injectWeakenArchiveSymbols(BUILD_SH, { [bad]: ['ieee80211_raw_frame_sanity_check'] }), /not a safe library basename/, `rejects ${bad}`);
  }
});
