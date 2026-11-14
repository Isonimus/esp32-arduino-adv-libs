// Regression tests for the host-side overlay rewrites behind the component slim (slice-0012,
// ADR-0011): defconfig symbol stripping, the CMakeLists Matter-define strip, and the in-container
// arduino-manifest strip injection into build.sh. The in-container python remover itself is proven
// separately (test/strip-manifest-components.test.mjs); the live arduino/builder trees are exercised
// by the CI build. These cover the pure, unit-assertable half: that each rewrite removes exactly its
// target and fails loud rather than silently no-op'ing when the target is already gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripDefconfigSymbols, stripBuilderCxxDefine, injectArduinoManifestStrip,
} from '../scripts/build.mjs';
import { checkDependenciesLock } from '../scripts/lib/dependencies-lock.mjs';
import { escapeRegExp } from '../scripts/lib/regex.mjs';

// A defconfig fragment with a removed-component symbol (INSIGHTS) sitting next to a kept one
// (COREDUMP) whose name it is a prefix-collision with, plus an "is not set" line.
const DEFCONFIG = [
  'CONFIG_ESP_INSIGHTS_ENABLED=y',
  'CONFIG_ESP_INSIGHTS_COREDUMP_ENABLE=n',
  'CONFIG_ESP_COREDUMP_ENABLE=y',
  'CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y',
  '# CONFIG_ESP_WIFI_IRAM_OPT is not set',
  'CONFIG_MBEDTLS_DYNAMIC_BUFFER=y',
].join('\n');

test('stripDefconfigSymbols removes exactly the named symbols, leaving prefix-colliding kept lines', () => {
  const out = stripDefconfigSymbols(DEFCONFIG, ['CONFIG_ESP_INSIGHTS_ENABLED', 'CONFIG_ESP_INSIGHTS_COREDUMP_ENABLE']);
  assert.ok(!/^CONFIG_ESP_INSIGHTS_ENABLED=/m.test(out), 'INSIGHTS_ENABLED should be gone');
  assert.ok(!/^CONFIG_ESP_INSIGHTS_COREDUMP_ENABLE=/m.test(out), 'INSIGHTS_COREDUMP should be gone');
  // The kept coredump lines share a prefix with the removed INSIGHTS_COREDUMP symbol: must survive.
  assert.ok(/^CONFIG_ESP_COREDUMP_ENABLE=y$/m.test(out), 'CONFIG_ESP_COREDUMP_ENABLE must survive');
  assert.ok(/^CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH=y$/m.test(out), 'CONFIG_ESP_COREDUMP_ENABLE_TO_FLASH must survive');
  assert.ok(out.includes('CONFIG_MBEDTLS_DYNAMIC_BUFFER=y'), 'unrelated line must survive');
});

test('stripDefconfigSymbols removes an "is not set" comment line for the symbol', () => {
  const out = stripDefconfigSymbols(DEFCONFIG, ['CONFIG_ESP_WIFI_IRAM_OPT']);
  assert.ok(!out.includes('CONFIG_ESP_WIFI_IRAM_OPT'), 'the "is not set" line should be removed');
});

test('stripDefconfigSymbols fails loud when a listed symbol has no line (stale cleanup, not a no-op)', () => {
  assert.throws(() => stripDefconfigSymbols(DEFCONFIG, ['CONFIG_NOT_PRESENT']), /CONFIG_NOT_PRESENT not found/);
});

const CMAKE_LINE = 'idf_build_set_property(CXX_COMPILE_OPTIONS "-std=gnu++2a;-DCHIP_HAVE_CONFIG_H" APPEND)';

test('stripBuilderCxxDefine removes the define and its separator, keeping the std flag', () => {
  const out = stripBuilderCxxDefine(CMAKE_LINE, 'CHIP_HAVE_CONFIG_H');
  assert.equal(out, 'idf_build_set_property(CXX_COMPILE_OPTIONS "-std=gnu++2a" APPEND)');
});

test('stripBuilderCxxDefine handles a trailing-separator position too', () => {
  const trailing = 'set(X "-DCHIP_HAVE_CONFIG_H;-std=gnu++2a")';
  assert.equal(stripBuilderCxxDefine(trailing, 'CHIP_HAVE_CONFIG_H'), 'set(X "-std=gnu++2a")');
});

test('stripBuilderCxxDefine fails loud when the define is already absent', () => {
  assert.throws(() => stripBuilderCxxDefine('set(X "-std=gnu++2a")', 'CHIP_HAVE_CONFIG_H'), /-DCHIP_HAVE_CONFIG_H" not found/);
});

test('stripBuilderCxxDefine does not corrupt a longer define it is a prefix of', () => {
  // -DCHIP_HAVE_CONFIG_H is not present as a whole element (only -DCHIP_HAVE_CONFIG_H_X is), so this
  // must fail loud, not silently mangle the longer flag into "-std=gnu++2a_X;-DB".
  assert.throws(
    () => stripBuilderCxxDefine('-std=gnu++2a;-DCHIP_HAVE_CONFIG_H_X;-DB', 'CHIP_HAVE_CONFIG_H'),
    /not found as a list element/,
  );
});

test('stripBuilderCxxDefine removes only the exact element when a prefix sibling is present', () => {
  assert.equal(stripBuilderCxxDefine('"-DFOO;-DFOO_X"', 'FOO'), '"-DFOO_X"');
  assert.equal(stripBuilderCxxDefine('"-DFOO_X;-DFOO"', 'FOO'), '"-DFOO_X"');
});

test('stripBuilderCxxDefine does not treat -DFOO=1 as the define -DFOO', () => {
  // A value-assigned define is a different list element; stripping -DFOO must not strip -DFOO=1.
  assert.throws(() => stripBuilderCxxDefine('"-std=c++2a;-DFOO=1"', 'FOO'), /not found as a list element/);
});

test('escapeRegExp escapes every metacharacter so a name is matched literally', () => {
  assert.equal(escapeRegExp('a.b+c(d)'), 'a\\.b\\+c\\(d\\)');
  // Round-trip: the escaped form matches the literal string and nothing else.
  assert.ok(new RegExp(`^${escapeRegExp('x.y')}$`).test('x.y'));
  assert.ok(!new RegExp(`^${escapeRegExp('x.y')}$`).test('xqy'));
});

// build.sh as it looks AFTER pinBuildSources injected the arduino force-checkout: the strip anchors
// on that checkout line, so it must land after it.
const ARDUINO_COMMIT = '9b3364c613c071a2e7322d49d467fd2166dbc70e';
const BUILD_SH = [
  '    # install arduino component',
  '    ./tools/install-arduino.sh',
  '    if [ $? -ne 0 ]; then exit 1; fi',
  '',
  `    git -C components/arduino_tinyusb/tinyusb checkout abc`,
  '    if [ $? -ne 0 ]; then exit 1; fi',
  `    git -C components/arduino checkout ${ARDUINO_COMMIT}`,
  '    if [ $? -ne 0 ]; then exit 1; fi',
  '    idf.py build',
  '',
].join('\n');

test('injectArduinoManifestStrip inserts the python strip call after the arduino checkout', () => {
  const out = injectArduinoManifestStrip(BUILD_SH, {
    arduinoCommit: ARDUINO_COMMIT,
    scriptName: 'strip-manifest-components.py',
    manifestPath: 'components/arduino/idf_component.yml',
    components: ['espressif/esp_rainmaker', 'espressif/cbor'],
  });
  const call = 'python3 strip-manifest-components.py components/arduino/idf_component.yml espressif/esp_rainmaker espressif/cbor';
  assert.ok(out.includes(call), 'the strip call must be injected');
  const checkoutAt = out.indexOf(`git -C components/arduino checkout ${ARDUINO_COMMIT}`);
  const stripAt = out.indexOf('python3 strip-manifest-components.py');
  const idfAt = out.indexOf('idf.py build');
  assert.ok(checkoutAt < stripAt, 'strip must run after the arduino checkout');
  assert.ok(stripAt < idfAt, 'strip must run before idf.py resolves');
});

test('injectArduinoManifestStrip fails loud if the checkout anchor is missing (pins did not run)', () => {
  assert.throws(() => injectArduinoManifestStrip('idf.py build\n', {
    arduinoCommit: ARDUINO_COMMIT, scriptName: 's.py', manifestPath: 'm.yml', components: ['espressif/cbor'],
  }), /arduino checkout anchor not found/);
});

test('injectArduinoManifestStrip requires arduinoCommit', () => {
  assert.throws(() => injectArduinoManifestStrip(BUILD_SH, {
    scriptName: 's.py', manifestPath: 'm.yml', components: ['espressif/cbor'],
  }), /arduinoCommit is required/);
});

// A dependencies.lock as the component manager writes it: one `<namespace>/<name>:` key per resolved
// component. The post-build gate reads this out of each chip's subtree in the zip.
const DEP_LOCK_GOOD = `dependencies:
  espressif/mdns:
    version: 1.2.3
  espressif/libsodium:
    version: 1.0.20
  espressif/esp-modbus:
    version: 1.0.15
  joltwallet/littlefs:
    version: 1.10.2
  idf:
    version: 5.5.0
manifest_hash: deadbeef
`;
const KEPT = ['espressif/mdns', 'espressif/libsodium', 'espressif/esp-modbus', 'joltwallet/littlefs'];
const REMOVED = ['espressif/esp_rainmaker', 'espressif/cbor', 'espressif/esp32-camera'];

test('checkDependenciesLock passes when every removed component is absent and every kept one present', () => {
  const r = checkDependenciesLock(DEP_LOCK_GOOD, 'esp32', { removed: REMOVED, kept: KEPT });
  assert.deepEqual(r.offenders, []);
  assert.deepEqual(r.missing, []);
});

test('checkDependenciesLock flags a removed component that reappears (e.g. pulled back transitively)', () => {
  const lockWithRainmaker = DEP_LOCK_GOOD.replace('  idf:', '  espressif/esp_rainmaker:\n    version: 1.5.2\n  idf:');
  const r = checkDependenciesLock(lockWithRainmaker, 'esp32', { removed: REMOVED, kept: KEPT });
  assert.deepEqual(r.offenders, ['espressif/esp_rainmaker']);
});

test('checkDependenciesLock flags a kept component missing from the resolved tree', () => {
  const lockMissingMdns = DEP_LOCK_GOOD.replace(/  espressif\/mdns:\n    version: 1.2.3\n/, '');
  const r = checkDependenciesLock(lockMissingMdns, 'esp32', { removed: REMOVED, kept: KEPT });
  assert.deepEqual(r.missing, ['espressif/mdns']);
});

test('checkDependenciesLock key match is exact, not a prefix (esp-modbus is not esp-modbus-extra)', () => {
  // A removed "espressif/esp-mod" must not false-match the kept "espressif/esp-modbus:" key.
  const r = checkDependenciesLock(DEP_LOCK_GOOD, 'esp32', { removed: ['espressif/esp-mod'], kept: [] });
  assert.deepEqual(r.offenders, [], 'a non-key substring must not count as present');
});

test('checkDependenciesLock treats a "." in a component name literally, not as "any char"', () => {
  // A removed "espressif/foo.bar" must not false-flag a resolved "espressif/fooXbar" (the "." would
  // match any character if the regex escaping were broken).
  const lock = 'dependencies:\n  espressif/fooXbar:\n    version: 1.0.0\n';
  const r = checkDependenciesLock(lock, 'esp32', { removed: ['espressif/foo.bar'], kept: [] });
  assert.deepEqual(r.offenders, [], '"." must be escaped to a literal dot');
  // And it still matches the real dotted name when present.
  const r2 = checkDependenciesLock('dependencies:\n  espressif/foo.bar:\n', 'esp32', { removed: ['espressif/foo.bar'], kept: [] });
  assert.deepEqual(r2.offenders, ['espressif/foo.bar']);
});
