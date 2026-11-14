// Regression tests for the pure lock-reader behind the source-pin reachability preflight
// (scripts/lib/source-pins.mjs, slice-0010 / ADR-0009). The network-gated ancestry check is proven
// live by scripts/0010-verify.mjs; these cover the half a unit test can assert: that the lock is
// turned into the right checks, and that an under-declared or malformed lock fails loud instead of
// silently dropping a pin from the gate (a dropped pin reads as green, which is worse than no gate).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePinChecks, assertRequiredSourcePins, REQUIRED_SOURCE_PINS } from '../scripts/lib/source-pins.mjs';

const SHA_A = '8410210c9a0427be9655a855ddfa3dc9c38a6aad';
const SHA_B = '9b3364c613c071a2e7322d49d467fd2166dbc70e';
const SHA_C = '91214b46142186b6c30ea468779c7ad39e1bc605';

// A complete lock: all three required floating sources pinned (assertRequiredSourcePins is strict).
const goodLock = () => ({
  sourcePins: { idfCommit: SHA_A, arduinoCommit: SHA_B, tinyusbCommit: SHA_C },
  sourcePinUpstreams: {
    idfCommit: { url: 'https://github.com/espressif/esp-idf.git', ref: 'release/v5.5' },
    arduinoCommit: { url: 'https://github.com/espressif/arduino-esp32.git', ref: 'master' },
    tinyusbCommit: { url: 'https://github.com/hathach/tinyusb.git', ref: 'master' },
  },
});

test('sourcePinChecks pairs each pin with its url, ref, and sha, in sourcePins order', () => {
  const checks = sourcePinChecks(goodLock());
  assert.deepEqual(checks, [
    { key: 'idfCommit', url: 'https://github.com/espressif/esp-idf.git', ref: 'release/v5.5', sha: SHA_A },
    { key: 'arduinoCommit', url: 'https://github.com/espressif/arduino-esp32.git', ref: 'master', sha: SHA_B },
    { key: 'tinyusbCommit', url: 'https://github.com/hathach/tinyusb.git', ref: 'master', sha: SHA_C },
  ]);
});

test('a pin with no sourcePinUpstreams entry fails loud, naming the key, not silently skipped', () => {
  const lock = goodLock();
  delete lock.sourcePinUpstreams.arduinoCommit;
  assert.throws(() => sourcePinChecks(lock), /arduinoCommit/);
});

test('an upstream entry naming a pin that does not exist fails loud', () => {
  const lock = goodLock();
  lock.sourcePinUpstreams.espCameraCommit = { url: 'https://github.com/espressif/esp32-camera.git', ref: 'master' };
  assert.throws(() => sourcePinChecks(lock), /espCameraCommit.*not in sourcePins/);
});

test('a non-40-hex commit fails loud rather than being fetched as a ref name', () => {
  const lock = goodLock();
  lock.sourcePins.idfCommit = 'release/v5.5';
  assert.throws(() => sourcePinChecks(lock), /idfCommit is not a 40-hex commit/);
});

test('a truncated (short) sha is rejected', () => {
  const lock = goodLock();
  lock.sourcePins.idfCommit = SHA_A.slice(0, 12);
  assert.throws(() => sourcePinChecks(lock), /not a 40-hex commit/);
});

test('an upstream entry missing url or ref fails loud', () => {
  const lock = goodLock();
  lock.sourcePinUpstreams.idfCommit = { ref: 'release/v5.5' };
  assert.throws(() => sourcePinChecks(lock), /idfCommit\.url/);
  const lock2 = goodLock();
  lock2.sourcePinUpstreams.idfCommit = { url: 'https://github.com/espressif/esp-idf.git' };
  assert.throws(() => sourcePinChecks(lock2), /idfCommit\.ref/);
});

test('a lock with no sourcePins or no sourcePinUpstreams fails loud', () => {
  assert.throws(() => sourcePinChecks({ sourcePinUpstreams: {} }), /sourcePins is missing/);
  assert.throws(() => sourcePinChecks({ sourcePins: {} }), /sourcePinUpstreams is missing/);
});

// Adversarial pass (slice-0010): a reduced pin set must not pass vacuously green. Before the
// REQUIRED_SOURCE_PINS guard, an empty sourcePins returned [] (preflight exit 0) and a lock with
// only idfCommit checked one pin while the build floated arduino+tinyusb (build.mjs skipped
// injection). These assert the guard closes both.
test('an empty sourcePins fails loud, it does not pass as "0 pins reachable"', () => {
  assert.throws(() => sourcePinChecks({ sourcePins: {}, sourcePinUpstreams: {} }), /missing required pin/);
});

test('a lock with only idfCommit fails loud, naming the dropped floating sources', () => {
  const lock = {
    sourcePins: { idfCommit: SHA_A },
    sourcePinUpstreams: { idfCommit: { url: 'https://github.com/espressif/esp-idf.git', ref: 'release/v5.5' } },
  };
  assert.throws(() => sourcePinChecks(lock), /arduinoCommit, tinyusbCommit/);
});

test('assertRequiredSourcePins is the shared contract the build and preflight both use', () => {
  assert.deepEqual(REQUIRED_SOURCE_PINS, ['idfCommit', 'arduinoCommit', 'tinyusbCommit']);
  assert.throws(() => assertRequiredSourcePins({ idfCommit: SHA_A, arduinoCommit: SHA_B }), /tinyusbCommit/);
  assert.doesNotThrow(() => assertRequiredSourcePins({ idfCommit: SHA_A, arduinoCommit: SHA_B, tinyusbCommit: SHA_A }));
});
