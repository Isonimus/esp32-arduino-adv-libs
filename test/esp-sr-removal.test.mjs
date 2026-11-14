// Regression tests for the host-side overlay rewrites behind the esp-sr removal (slice-0018, ADR-0017):
// removeBuildFeatures (drops the esp_sr feature from the esp32s3 target in configs/builds.json) and
// stripEspSrModelStep (removes esp-sr's dedicated srmodels_bin step from build.sh). esp-sr's absence
// from the resolved dependency tree, the shipped artifact shape, and the esp32s3 flash-size fallback are
// proven on the built zip by scripts/0012-verify.mjs, scripts/0002-verify.mjs and scripts/0018-verify.mjs
// in CI. These cover the pure, unit-assertable half: each rewrite removes exactly its target and fails
// loud rather than silently no-op'ing when the target is already gone or the upstream layout changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeBuildFeatures, stripEspSrModelStep } from '../scripts/build.mjs';

// A fragment shaped like configs/builds.json: the two targets we ship, esp32s3 carrying the esp_sr
// feature, esp32 carrying none of it. Tab-indented like upstream (the structural parser ignores layout).
const BUILDS_JSON = JSON.stringify({
  targets: [
    { target: 'esp32', features: ['qio_ram'], idf_libs: ['qio', '80m'], bootloaders: [['qio', '80m']] },
    { target: 'esp32s3', features: ['esp_sr'], idf_libs: ['qio', '80m', 'qio_ram'], bootloaders: [['qio', '80m', 'qio_ram']] },
  ],
}, null, '\t');

test('removeBuildFeatures drops the named feature from the keyed target and leaves the rest intact', () => {
  const out = JSON.parse(removeBuildFeatures(BUILDS_JSON, { esp32s3: ['esp_sr'] }));
  const s3 = out.targets.find((t) => t.target === 'esp32s3');
  const esp32 = out.targets.find((t) => t.target === 'esp32');
  assert.deepEqual(s3.features, [], 'esp_sr removed from esp32s3 features');
  assert.deepEqual(s3.idf_libs, ['qio', '80m', 'qio_ram'], 'esp32s3 idf_libs untouched');
  assert.deepEqual(s3.bootloaders, [['qio', '80m', 'qio_ram']], 'esp32s3 bootloaders untouched');
  assert.deepEqual(esp32.features, ['qio_ram'], 'esp32 target untouched');
});

test('removeBuildFeatures re-serialises as valid, tab-indented JSON with a trailing newline', () => {
  const text = removeBuildFeatures(BUILDS_JSON, { esp32s3: ['esp_sr'] });
  assert.ok(text.endsWith('\n'), 'trailing newline');
  assert.ok(text.includes('\n\t"targets"'), 'tab-indented like upstream');
  assert.doesNotThrow(() => JSON.parse(text), 'still parses');
});

test('removeBuildFeatures is identity for an empty or undefined map', () => {
  assert.equal(removeBuildFeatures(BUILDS_JSON, {}), BUILDS_JSON);
  assert.equal(removeBuildFeatures(BUILDS_JSON, undefined), BUILDS_JSON);
});

test('removeBuildFeatures fails loud when the target is absent', () => {
  assert.throws(() => removeBuildFeatures(BUILDS_JSON, { esp32p4: ['esp_sr'] }), /target "esp32p4" not found/);
});

test('removeBuildFeatures fails loud when the feature is not present on the target', () => {
  // Guards against a stale removal silently no-op'ing (e.g. upstream already dropped esp_sr).
  assert.throws(() => removeBuildFeatures(BUILDS_JSON, { esp32s3: ['opi_ram'] }), /feature "opi_ram" not present in target "esp32s3"/);
  // And against re-running the removal on an already-stripped tree.
  const once = removeBuildFeatures(BUILDS_JSON, { esp32s3: ['esp_sr'] });
  assert.throws(() => removeBuildFeatures(once, { esp32s3: ['esp_sr'] }), /feature "esp_sr" not present/);
});

test('removeBuildFeatures fails loud when a target has no features array', () => {
  const noFeatures = JSON.stringify({ targets: [{ target: 'esp32s3', idf_libs: ['qio'] }] });
  assert.throws(() => removeBuildFeatures(noFeatures, { esp32s3: ['esp_sr'] }), /has no features array/);
});

test('removeBuildFeatures fails loud when builds.json has no targets array', () => {
  assert.throws(() => removeBuildFeatures('{}', { esp32s3: ['esp_sr'] }), /no targets array/);
});

test('removeBuildFeatures fails loud when a target maps to a non-array value', () => {
  // A hand-edited lock with `"esp32s3": "esp_sr"` (a string) must not be iterated character by
  // character or string-matched; it surfaces with a clear message, not a confusing downstream throw.
  assert.throws(() => removeBuildFeatures(BUILDS_JSON, { esp32s3: 'esp_sr' }), /must be an array of feature names/);
});

// A fragment shaped like the esp32s3 idf-libs region of build.sh: the generic idf-libs build with its
// own error check, then the esp32s3-only srmodels_bin block (the one stripEspSrModelStep removes),
// then the next section. Exactly the pinned-builder layout (4-space indent, blank lines between).
const BUILD_SH = [
  '    echo "* Build IDF-Libs: $idf_libs_configs"',
  '    rm -rf build sdkconfig',
  '    idf.py -DIDF_TARGET="$target" -DSDKCONFIG_DEFAULTS="$idf_libs_configs" idf-libs',
  '    if [ $? -ne 0 ]; then exit 1; fi',
  '',
  '    if [ "$target" == "esp32s3" ]; then',
  '        idf.py -DIDF_TARGET="$target" -DSDKCONFIG_DEFAULTS="$idf_libs_configs" srmodels_bin',
  '        if [ $? -ne 0 ]; then exit 1; fi',
  '        AR_SDK="$AR_TOOLS/esp32-arduino-libs/$target"',
  '        # sr model.bin',
  '        if [ -f "build/srmodels/srmodels.bin" ]; then',
  '            echo "$AR_SDK/esp_sr"',
  '            mkdir -p "$AR_SDK/esp_sr"',
  '            cp -f "build/srmodels/srmodels.bin" "$AR_SDK/esp_sr/"',
  '            cp -f "partitions.csv" "$AR_SDK/esp_sr/"',
  '        fi',
  '    fi',
  '',
  '    # Build Bootloaders',
  '    for boot_conf in `echo "$target_json" | jq -c \'.bootloaders[]\'`; do',
  '',
].join('\n');

test('stripEspSrModelStep removes the whole esp32s3 srmodels block and nothing else', () => {
  const out = stripEspSrModelStep(BUILD_SH);
  // Every line of the srmodels block is gone.
  for (const gone of ['srmodels_bin', 'AR_SDK', 'esp_sr', 'build/srmodels/srmodels.bin', 'partitions.csv', 'if [ "$target" == "esp32s3" ]']) {
    assert.ok(!out.includes(gone), `removed: ${gone}`);
  }
  // The surrounding code survives verbatim.
  assert.ok(out.includes('idf.py -DIDF_TARGET="$target" -DSDKCONFIG_DEFAULTS="$idf_libs_configs" idf-libs'), 'idf-libs build kept');
  assert.ok(out.includes('# Build Bootloaders'), 'next section kept');
  // The idf-libs error check (a generic `if [ $? -ne 0 ]; then exit 1; fi`) is untouched.
  assert.ok(out.includes('    if [ $? -ne 0 ]; then exit 1; fi'), 'generic error check kept');
  // Exactly one blank line is left where the block was, not a doubled blank.
  assert.ok(out.includes('    if [ $? -ne 0 ]; then exit 1; fi\n\n    # Build Bootloaders'), 'collapses to a single blank line');
  assert.ok(!out.includes('\n\n\n'), 'no tripled newline left behind');
});

test('stripEspSrModelStep fails loud when the esp32s3 srmodels block is absent', () => {
  // Upstream moved or removed the step: the strip must surface rather than silently no-op (which would
  // leave a build-breaking step if the block were only reshaped).
  const withoutBlock = [
    '    idf.py -DIDF_TARGET="$target" -DSDKCONFIG_DEFAULTS="$idf_libs_configs" idf-libs',
    '    if [ $? -ne 0 ]; then exit 1; fi',
    '',
    '    # Build Bootloaders',
  ].join('\n');
  assert.throws(() => stripEspSrModelStep(withoutBlock), /srmodels_bin block not found/);
});

test('stripEspSrModelStep fails loud if the matched span overruns into the next section', () => {
  // Upstream drops the esp32s3 guard's own closing `fi` (a reshape): the first `\n    fi\n` after the
  // anchor is then the bootloader loop's `fi`, so a first-match end anchor would delete the whole
  // bootloader section. The overrun guard must refuse rather than silently delete it.
  const reshaped = [
    '    if [ $? -ne 0 ]; then exit 1; fi',
    '    if [ "$target" == "esp32s3" ]; then',
    '        idf.py -DIDF_TARGET="$target" -DSDKCONFIG_DEFAULTS="$idf_libs_configs" srmodels_bin',
    '        AR_SDK="$AR_TOOLS/esp32-arduino-libs/$target"',
    '        cp -f "build/srmodels/srmodels.bin" "$AR_SDK/esp_sr/"',
    '',
    '    # Build Bootloaders',
    '    for boot_conf in `echo "$target_json" | jq -c \'.bootloaders[]\'`; do',
    '        echo build',
    '    fi',
    '',
  ].join('\n');
  assert.throws(() => stripEspSrModelStep(reshaped), /overruns into/);
});

test('stripEspSrModelStep fails loud if the matched span is missing the srmodels markers', () => {
  // Upstream reshapes the step to just the build with no model-copy block: the first `\n    fi\n` now
  // closes right after the srmodels_bin call, so the matched span lacks srmodels.bin and AR_SDK. The
  // marker guard must refuse rather than delete a block it cannot confirm is the srmodels block.
  const noModelCopy = [
    '    if [ $? -ne 0 ]; then exit 1; fi',
    '    if [ "$target" == "esp32s3" ]; then',
    '        idf.py -DIDF_TARGET="$target" -DSDKCONFIG_DEFAULTS="$idf_libs_configs" srmodels_bin',
    '        echo "no model copy here"',
    '    fi',
    '    # next section',
    '',
  ].join('\n');
  assert.throws(() => stripEspSrModelStep(noModelCopy), /missing "srmodels\.bin"|missing "AR_SDK"/);
});

test('stripEspSrModelStep leaves an unrelated esp32s3 guard that is not the srmodels step alone', () => {
  // The anchor is the guard line immediately followed by the srmodels_bin idf.py call; a different
  // esp32s3 guard (no srmodels_bin on the next line) must not match, so the strip fails loud rather
  // than removing the wrong block.
  const otherGuard = [
    '    if [ $? -ne 0 ]; then exit 1; fi',
    '    if [ "$target" == "esp32s3" ]; then',
    '        echo "something unrelated"',
    '    fi',
  ].join('\n');
  assert.throws(() => stripEspSrModelStep(otherGuard), /srmodels_bin block not found/);
});
