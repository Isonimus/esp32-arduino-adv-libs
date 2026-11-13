// Regression tests for the pure build helpers (scripts/build.mjs) hardened in the slice-0002
// adversarial pass. Each targets one fix and is written to fail if that fix is reverted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pinDockerfileFrom, parseVersionsText, reconcileVersions, chipBuildCommand, pinComponentVersions, pinBuildSources, removeManagedComponents, setBuilderCxxStandard } from '../scripts/build.mjs';

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

// Real stock-builder (e68e301) format: "<name>: <short-sha>", one token after the label, with
// lib-builder/tinyusb/component lines interleaved that the parser must ignore. Captured from the
// first green run's chip artifact (run 43517943974).
const VALID_VERSIONS = 'lib-builder: e68e301\nesp-idf: 8410210c9a0\narduino: 9b3364c61\ntinyusb: 91214b461\nespressif__mdns: 1.15.1\n';

test('parseVersionsText extracts the resolved idf and arduino commits', () => {
  assert.deepEqual(parseVersionsText(VALID_VERSIONS, 'esp32'), {
    idf: '8410210c9a0',
    arduino: '9b3364c61',
  });
});

test('parseVersionsText fails loud when a commit line is missing', () => {
  assert.throws(
    () => parseVersionsText('esp-idf: 8410210c9a0\n', 'esp32'),
    /could not resolve idf\/arduino commits from esp32/,
  );
});

test('parseVersionsText fails loud rather than recording a branch token as a commit', () => {
  // A hypothetical "<name>: <branch> <sha>" line must not silently resolve to the branch: the hex
  // guard rejects "release/v5.5", so no idf is captured and the fail-loud throw fires (invariant 5).
  assert.throws(
    () => parseVersionsText('esp-idf: release/v5.5 8410210c9a0\narduino: 9b3364c61\n', 'esp32'),
    /could not resolve idf\/arduino commits from esp32 versions\.txt \(idf="", arduino="9b3364c61"\)/,
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
      esp32: 'esp-idf: 8410210c9a0\narduino: 9b3364c61\n',
      esp32s3: 'esp-idf: 8410210c9a0\narduino: 9b3364c61\nextra: s3-only line\n',
    });
    assert.deepEqual(resolved, { idf: '8410210c9a0', arduino: '9b3364c61' });
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
        esp32: 'esp-idf: 8410210c9a0\narduino: 9b3364c61\n',
        esp32s3: 'esp-idf: deadbeef990\narduino: 9b3364c61\n',
      }),
      /chips disagree on resolved sources/,
    );
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

// --- chipBuildCommand (ADR-0003, ADR-0005): IDF selected by branch AND pinned by commit -------------

const SHA = '8410210c9a0427be9655a855ddfa3dc9c38a6aad';

test('chipBuildCommand passes -I <idfBranch> so the build does not fall back to the builder default', () => {
  // The upstream config.sh defaults IDF_BRANCH to release/v5.3; dropping -I silently builds 5.3.
  const cmd = chipBuildCommand('esp32', 'release/v5.5', SHA);
  assert.match(cmd, /\.\/build\.sh .*-I release\/v5\.5\b/);
  assert.match(cmd, /-t esp32\b/);
});

test('chipBuildCommand pins the IDF commit with -i so the build does not track a floating branch head', () => {
  const cmd = chipBuildCommand('esp32', 'release/v5.5', SHA);
  assert.match(cmd, new RegExp(`-i ${SHA}\\b`));
});

test('chipBuildCommand marks the mounted tree safe before invoking build.sh', () => {
  const cmd = chipBuildCommand('esp32s3', 'release/v5.5', SHA);
  assert.match(cmd, /^git config --global --add safe\.directory '\*' && \.\/build\.sh/);
});

test('chipBuildCommand refuses a missing idfBranch rather than build the wrong IDF', () => {
  assert.throws(() => chipBuildCommand('esp32', '', SHA), /idfBranch is required/);
  assert.throws(() => chipBuildCommand('esp32', undefined, SHA), /idfBranch is required/);
});

test('chipBuildCommand refuses a missing idfCommit rather than track a floating head', () => {
  assert.throws(() => chipBuildCommand('esp32', 'release/v5.5', ''), /idfCommit is required/);
  assert.throws(() => chipBuildCommand('esp32', 'release/v5.5', undefined), /idfCommit is required/);
});

test('chipBuildCommand refuses a missing chip', () => {
  assert.throws(() => chipBuildCommand('', 'release/v5.5', SHA), /chip is required/);
});

// --- pinBuildSources (ADR-0005): pin arduino + tinyusb clones to exact commits ----------------------

const BUILD_SH = `mkdir -p dist

if [ $SKIP_ENV -eq 0 ]; then
    echo "* Installing/Updating ESP-IDF and all components..."
    # update components from git
    ./tools/update-components.sh
    if [ $? -ne 0 ]; then exit 1; fi

    # install arduino component
    ./tools/install-arduino.sh
    if [ $? -ne 0 ]; then exit 1; fi

    # install esp-idf
    source ./tools/install-esp-idf.sh
    if [ $? -ne 0 ]; then exit 1; fi
fi
`;
const AR = '9b3364c613c071a2e7322d49d467fd2166dbc70e';
const TU = '91214b46142186b6c30ea468779c7ad39e1bc605';

test('pinBuildSources force-checks-out both floating repos to their pinned commits', () => {
  const out = pinBuildSources(BUILD_SH, { arduinoCommit: AR, tinyusbCommit: TU });
  assert.match(out, new RegExp(`git -C components/arduino_tinyusb/tinyusb checkout ${TU}`));
  assert.match(out, new RegExp(`git -C components/arduino checkout ${AR}`));
});

test('pinBuildSources injects AFTER install-arduino.sh, so the clones exist when checked out', () => {
  const out = pinBuildSources(BUILD_SH, { arduinoCommit: AR, tinyusbCommit: TU });
  assert.ok(out.indexOf('./tools/install-arduino.sh') < out.indexOf(`checkout ${AR}`));
  // and before the esp-idf install step that follows
  assert.ok(out.indexOf(`checkout ${AR}`) < out.indexOf('install-esp-idf.sh'));
});

test('pinBuildSources fails loud if the upstream anchor is gone rather than skip pinning', () => {
  assert.throws(
    () => pinBuildSources('echo no anchor here\n', { arduinoCommit: AR, tinyusbCommit: TU }),
    /anchor not found/,
  );
});

test('pinBuildSources fails loud on a missing commit rather than inject a bare checkout', () => {
  assert.throws(() => pinBuildSources(BUILD_SH, { arduinoCommit: AR }), /tinyusbCommit is required/);
  assert.throws(() => pinBuildSources(BUILD_SH, { tinyusbCommit: TU }), /arduinoCommit is required/);
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

// --- removeManagedComponents (ADR-0006): drop a managed component the consumers never use ----------

// Mirrors the real builder main/idf_component.yml: esp_matter is the last block and carries a
// nested rules: list, so removal must take the whole indented block through end-of-file.
const MANIFEST_WITH_MATTER = `dependencies:
  idf: ">=5.3"
  espressif/esp-tflite-micro:
    version: ">=1.2.0"
    require: public
    rules:
      - if: "target not in [esp32c2]"
  espressif/esp_matter:
    version: "^1.3.0"
    require: public
    rules:
      - if: "target not in [esp32c2, esp32h2, esp32p4]"
`;

test('removeManagedComponents drops the whole block, nested rules and all, leaving others intact', () => {
  const out = removeManagedComponents(MANIFEST_WITH_MATTER, ['espressif/esp_matter']);
  assert.ok(!out.includes('espressif/esp_matter'), 'the component key is gone');
  assert.ok(!out.includes('esp32h2'), 'the nested rules line is gone too');
  // The surviving component keeps its full block.
  assert.match(out, /espressif\/esp-tflite-micro:\n {4}version: ">=1\.2\.0"\n {4}require: public\n {4}rules:\n {6}- if: "target not in \[esp32c2\]"/);
  assert.match(out, /^ {2}idf: ">=5\.3"$/m);
});

test('removeManagedComponents removes a middle block without eating the next component', () => {
  const out = removeManagedComponents(MANIFEST_WITH_MATTER, ['espressif/esp-tflite-micro']);
  assert.ok(!out.includes('espressif/esp-tflite-micro'));
  assert.ok(!out.includes('esp32c2]"\n'), 'tflite rules line gone');
  // esp_matter (the block after the removed one) survives whole.
  assert.match(out, /espressif\/esp_matter:\n {4}version: "\^1\.3\.0"\n {4}require: public/);
});

test('removeManagedComponents fails loud on an absent component rather than silently no-op', () => {
  assert.throws(
    () => removeManagedComponents(MANIFEST_WITH_MATTER, ['espressif/not-here']),
    /not found in manifest/,
  );
});

// --- setBuilderCxxStandard (ADR-0007): bump the builder's forced C++ standard to C++20 -------------

// Mirrors the real builder root CMakeLists.txt line 42: gnu++17 is appended after IDF's gnu++2b, so
// the last flag wins and the project compiles as C++17, which the newer arduino/esp-dl cannot.
const CMAKE_WITH_GNU17 = `cmake_minimum_required(VERSION 3.16)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
idf_build_set_property(CXX_COMPILE_OPTIONS "-std=gnu++17;-DCHIP_HAVE_CONFIG_H" APPEND)
project(arduino-lib-builder)
`;

test('setBuilderCxxStandard rewrites the forced standard and leaves the rest of the line intact', () => {
  const out = setBuilderCxxStandard(CMAKE_WITH_GNU17, { from: 'gnu++17', to: 'gnu++2a' });
  assert.ok(!out.includes('-std=gnu++17'), 'the old standard flag is gone');
  assert.match(out, /CXX_COMPILE_OPTIONS "-std=gnu\+\+2a;-DCHIP_HAVE_CONFIG_H" APPEND/, 'only the std flag changed; the CHIP define and APPEND stay');
  assert.match(out, /^project\(arduino-lib-builder\)$/m, 'unrelated lines untouched');
});

test('setBuilderCxxStandard fails loud when the expected standard is absent rather than silently no-op', () => {
  assert.throws(
    () => setBuilderCxxStandard('project(x)\n', { from: 'gnu++17', to: 'gnu++2a' }),
    /not found in CMakeLists\.txt/,
  );
});

test('setBuilderCxxStandard fails loud on a malformed pin rather than writing "-std=undefined"', () => {
  // A dropped "to" key must not pass the from-present check and then write a corrupt flag.
  assert.throws(
    () => setBuilderCxxStandard(CMAKE_WITH_GNU17, { from: 'gnu++17' }),
    /must be non-empty strings/,
  );
  assert.throws(
    () => setBuilderCxxStandard(CMAKE_WITH_GNU17, { from: '', to: 'gnu++2a' }),
    /must be non-empty strings/,
  );
});
