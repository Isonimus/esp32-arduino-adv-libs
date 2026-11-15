// Regression tests for the resolved-dependency drift gate's pure core (slice-0027, ADR-0026):
// projectDependenciesLock (parse a component-manager dependencies.lock down to the provenance-meaningful
// projection) and diffDependencyLocks (name every drift between a committed snapshot and a fresh build).
// The live gate (scripts/0027-verify.mjs) reads <chip>/dependencies.lock out of the built zip and runs
// exactly these two functions; the CI build proves the zip half, these prove the projection and diff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectDependenciesLock, diffDependencyLocks } from '../scripts/lib/dependencies-lock.mjs';

// A dependencies.lock shaped like the component manager's real output (indentation is load-bearing):
// a resolved `version:` at 4 spaces is the pin; a requirement `version:` at 6 spaces under a `- name:`
// list item is a range and must NOT be read as the resolved version.
const LOCK = `dependencies:
  espressif/esp-dsp:
    component_hash: ed9ac175b14e0414399a2b33c525579414b5bad19a2a67b12ea212def96f9a98
    dependencies:
    - name: idf
      require: private
      version: '>=4.2'
    source:
      registry_url: https://components.espressif.com/
      type: service
    version: 1.8.2
  espressif/libsodium:
    component_hash: d4066b373fc6d4c5196db42aeea7faef4ac7f3080af96c2b74e2476c08b78dc1
    dependencies:
    - name: idf
      require: private
      version: '>=4.2'
    source:
      registry_url: https://components.espressif.com/
      type: service
    version: 1.0.22~1
  idf:
    source:
      type: idf
    version: 5.5.1
direct_dependencies:
- espressif/esp-dsp
- espressif/libsodium
- idf
manifest_hash: 36820cd86476177af945f83cb7f415c9d5a539409339e96abc7d7ccd2a584c71
target: esp32
version: 2.0.0
`;

test('projectDependenciesLock captures the resolved version, not the nested requirement range', () => {
  const p = projectDependenciesLock(LOCK, { chip: 'esp32' });
  assert.equal(p.target, 'esp32');
  // The 4-space resolved version, never the 6-space '>=4.2' requirement spec.
  assert.equal(p.components['espressif/esp-dsp'].version, '1.8.2');
  assert.equal(
    p.components['espressif/esp-dsp'].hash,
    'ed9ac175b14e0414399a2b33c525579414b5bad19a2a67b12ea212def96f9a98',
  );
  // A quoted scalar sheds its quotes; idf carries a version and no hash.
  assert.equal(p.components['espressif/libsodium'].version, '1.0.22~1');
  assert.equal(p.components.idf.version, '5.5.1');
  assert.equal(p.components.idf.hash, null);
  assert.deepEqual(p.directDependencies, ['espressif/esp-dsp', 'espressif/libsodium', 'idf']);
});

test('projectDependenciesLock fails loud on a lock with no target (not a component-manager lock)', () => {
  assert.throws(() => projectDependenciesLock('dependencies:\n  idf:\n    version: 5.5.1\n'), /no "target:"/);
});

test('projectDependenciesLock fails loud when a resolved component has no version', () => {
  const broken = 'dependencies:\n  espressif/mdns:\n    component_hash: abc\ntarget: esp32\n';
  assert.throws(() => projectDependenciesLock(broken), /espressif\/mdns" has no resolved version/);
});

test('projectDependenciesLock fails loud on an empty dependencies block', () => {
  assert.throws(() => projectDependenciesLock('dependencies:\ntarget: esp32\n'), /no resolved components/);
});

test('diffDependencyLocks reports no drift when the projection is identical', () => {
  const a = projectDependenciesLock(LOCK, { chip: 'esp32' });
  const b = projectDependenciesLock(LOCK, { chip: 'esp32' });
  assert.deepEqual(diffDependencyLocks(a, b), []);
});

test('diffDependencyLocks catches a bumped transitive version', () => {
  const expected = projectDependenciesLock(LOCK, { chip: 'esp32' });
  const actual = projectDependenciesLock(LOCK.replace('version: 1.8.2', 'version: 1.9.0'), { chip: 'esp32' });
  assert.deepEqual(diffDependencyLocks(expected, actual), ['version changed: espressif/esp-dsp 1.8.2 -> 1.9.0']);
});

test('diffDependencyLocks catches a re-packed component (same version, new content hash)', () => {
  const expected = projectDependenciesLock(LOCK, { chip: 'esp32' });
  const repacked = LOCK.replace(
    'component_hash: ed9ac175b14e0414399a2b33c525579414b5bad19a2a67b12ea212def96f9a98',
    'component_hash: 0000000000000000000000000000000000000000000000000000000000000000',
  );
  const actual = projectDependenciesLock(repacked, { chip: 'esp32' });
  const diffs = diffDependencyLocks(expected, actual);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /^component_hash changed: espressif\/esp-dsp \(1\.8\.2\) ed9ac175b14e\.\.\. -> 000000000000\.\.\./);
});

test('diffDependencyLocks catches an added and a removed component', () => {
  const expected = projectDependenciesLock(LOCK, { chip: 'esp32' });
  // Drop libsodium, add a newly-pulled esp-sr; also reflect it in direct_dependencies.
  const changed = LOCK
    .replace(/  espressif\/libsodium:\n(?:.*\n)*?    version: 1\.0\.22~1\n/, '  espressif/esp-sr:\n    component_hash: feed\n    version: 2.0.0\n')
    .replace('- espressif/libsodium', '- espressif/esp-sr');
  const actual = projectDependenciesLock(changed, { chip: 'esp32' });
  const diffs = diffDependencyLocks(expected, actual);
  assert.ok(diffs.includes('component added: espressif/esp-sr (now 2.0.0)'), diffs.join('; '));
  assert.ok(diffs.includes('component removed: espressif/libsodium (was 1.0.22~1)'), diffs.join('; '));
  assert.ok(diffs.some((d) => d.startsWith('direct_dependencies changed:')), diffs.join('; '));
});

test('diffDependencyLocks catches a chip/target mix-up (esp32 snapshot vs esp32s3 build)', () => {
  const expected = projectDependenciesLock(LOCK, { chip: 'esp32' });
  const actual = projectDependenciesLock(LOCK.replace('target: esp32', 'target: esp32s3'), { chip: 'esp32s3' });
  assert.ok(diffDependencyLocks(expected, actual).includes('target: expected esp32, built esp32s3'));
});
