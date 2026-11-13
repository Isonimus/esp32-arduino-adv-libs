// Regression tests for the pure build helpers (scripts/build.mjs) hardened in the slice-0002
// adversarial pass. Each targets one fix and is written to fail if that fix is reverted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinDockerfileFrom, parseVersionsText, reconcileVersions, chipBuildCommand, pinComponentVersions } from '../scripts/build.mjs';

const BASE = 'ubuntu:22.04';
const DIGEST = 'sha256:74b12b11ffa550fba1929ad4d8d16533c34f6612728469671afba1b03b66881c';

// --- pinDockerfileFrom (F6): anchored, single-match FROM rewrite ------------------------------------

test('pinDockerfileFrom rewrites the single FROM line to pin the base by digest', () => {
  const out = pinDockerfileFrom(`FROM ${BASE}\nRUN apt-get update\n`, BASE, DIGEST);
  assert.match(out, new RegExp(`^FROM ${BASE.replace('.', '\\.')}@${DIGEST}$`, 'm'));
  assert.ok(out.includes('RUN apt-get update'));
});

test('pinDockerfileFrom refuses a commented-out FROM (0 real matches)', () => {
  // A naive includes()/replace() would pin the comment; the anchored regex must not match it.
  assert.throws(
    () => pinDockerfileFrom(`# FROM ${BASE} (old)\nFROM scratch\n`, BASE, DIGEST),
    /expected exactly one .* found 0/,
  );
});

test('pinDockerfileFrom does not mis-pin a longer tag like 22.04.1', () => {
  // Substring matching would mangle ubuntu:22.04.1; the whole-token anchor must reject it.
  assert.throws(
    () => pinDockerfileFrom('FROM ubuntu:22.04.1\n', BASE, DIGEST),
    /expected exactly one .* found 0/,
  );
});

test('pinDockerfileFrom refuses two matching FROM lines (ambiguous base)', () => {
  assert.throws(
    () => pinDockerfileFrom(`FROM ${BASE}\nFROM ${BASE}\n`, BASE, DIGEST),
    /expected exactly one .* found 2/,
  );
});

// --- parseVersionsText -----------------------------------------------------------------------------

const VALID_VERSIONS = 'esp-idf: release/v5.5 8410210c9a\narduino: master 32709d56d\n';

test('parseVersionsText extracts the resolved idf and arduino commits', () => {
  assert.deepEqual(parseVersionsText(VALID_VERSIONS, 'esp32'), {
    idf: '8410210c9a',
    arduino: '32709d56d',
  });
});

test('parseVersionsText fails loud when a commit line is missing', () => {
  assert.throws(
    () => parseVersionsText('esp-idf: release/v5.5 8410210c9a\n', 'esp32'),
    /could not resolve idf\/arduino commits from esp32/,
  );
});

// --- reconcileVersions (F4): cross-chip agreement, not last-chip-wins ------------------------------

function tempOut() {
  return join(mkdtempSync(join(tmpdir(), 'adv-build-')), 'versions.txt');
}

test('reconcileVersions returns the shared commits and writes the unioned file when chips agree', () => {
  const out = tempOut();
  try {
    const resolved = reconcileVersions(out, {
      esp32: 'esp-idf: release/v5.5 8410210c9a\narduino: master 32709d56d\n',
      esp32s3: 'esp-idf: release/v5.5 8410210c9a\narduino: master 32709d56d\nextra: s3-only line\n',
    });
    assert.deepEqual(resolved, { idf: '8410210c9a', arduino: '32709d56d' });
    const written = readFileSync(out, 'utf8');
    assert.ok(written.includes('extra: s3-only line'), 'union must keep a chip-unique line');
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('reconcileVersions fails loud when two chips disagree on resolved sources', () => {
  const out = tempOut();
  try {
    assert.throws(
      () => reconcileVersions(out, {
        esp32: 'esp-idf: release/v5.5 8410210c9a\narduino: master 32709d56d\n',
        esp32s3: 'esp-idf: release/v5.5 DEADBEEF99\narduino: master 32709d56d\n',
      }),
      /chips disagree on resolved sources/,
    );
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

// --- chipBuildCommand (ADR-0003): the IDF branch must be selected explicitly ------------------------

test('chipBuildCommand passes -I <idfBranch> so the build does not fall back to the builder default', () => {
  // The upstream config.sh defaults IDF_BRANCH to release/v5.3; dropping -I silently builds 5.3.
  const cmd = chipBuildCommand('esp32', 'release/v5.5');
  assert.match(cmd, /\.\/build\.sh .*-I release\/v5\.5\b/);
  assert.match(cmd, /-t esp32\b/);
});

test('chipBuildCommand marks the mounted tree safe before invoking build.sh', () => {
  const cmd = chipBuildCommand('esp32s3', 'release/v5.5');
  assert.match(cmd, /^git config --global --add safe\.directory '\*' && \.\/build\.sh/);
});

test('chipBuildCommand refuses a missing idfBranch rather than build the wrong IDF', () => {
  assert.throws(() => chipBuildCommand('esp32', ''), /idfBranch is required/);
  assert.throws(() => chipBuildCommand('esp32', undefined), /idfBranch is required/);
});

test('chipBuildCommand refuses a missing chip', () => {
  assert.throws(() => chipBuildCommand('', 'release/v5.5'), /chip is required/);
});

// --- pinComponentVersions (ADR-0004): pin a floating managed-component version ----------------------

const MANIFEST = `dependencies:
  idf: ">=5.3"
  espressif/esp32-camera:
    version: "master"
    git: https://github.com/espressif/esp32-camera.git
    require: public
  espressif/esp-tflite-micro:
    version: ">=1.2.0"
    require: public
    rules:
      - if: "target not in [esp32c2]"
  espressif/esp-sr:
    version: ">=1.4.2"
`;

test('pinComponentVersions pins the targeted component and leaves others untouched', () => {
  const out = pinComponentVersions(MANIFEST, { 'espressif/esp-tflite-micro': '==1.3.5' });
  assert.match(out, /espressif\/esp-tflite-micro:\n {4}version: "==1\.3\.5"/);
  // The neighbouring components keep their original specs.
  assert.match(out, /espressif\/esp32-camera:\n {4}version: "master"/);
  assert.match(out, /espressif\/esp-sr:\n {4}version: ">=1\.4\.2"/);
  // Non-version keys of the pinned block survive.
  assert.match(out, /espressif\/esp-tflite-micro:\n {4}version: "==1\.3\.5"\n {4}require: public/);
});

test('pinComponentVersions rewrites only the pinned block, not a same-named key elsewhere', () => {
  // esp32-camera also has a version line; pinning tflite must not touch it.
  const out = pinComponentVersions(MANIFEST, { 'espressif/esp-tflite-micro': '==1.3.5' });
  assert.ok(!/espressif\/esp32-camera:\n {4}version: "==1\.3\.5"/.test(out));
});

test('pinComponentVersions fails loud on an absent component rather than silently no-op', () => {
  assert.throws(
    () => pinComponentVersions(MANIFEST, { 'espressif/does-not-exist': '==1.0.0' }),
    /not found in manifest/,
  );
});

test('pinComponentVersions fails loud when the component block has no version line', () => {
  const noVersion = `dependencies:
  espressif/weird:
    require: public
`;
  assert.throws(
    () => pinComponentVersions(noVersion, { 'espressif/weird': '==1.0.0' }),
    /no "version:" line/,
  );
});
