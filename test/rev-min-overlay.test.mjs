// Regression tests for the esp32 ESP32_REV_MIN=3 defconfig-append overlay (slice-0014, ADR-0013):
// appendDefconfigLines (the pure text transform) and applyAddedDefconfigLines (its fs wrapper). The
// append sets a CONFIG_ the stock defconfig.esp32 omits, so the resolved esp32 config takes rev-3
// minimum, drops the PSRAM cache workaround, and keeps libc out of IRAM. These cover the append/
// preserve/fail-loud-on-present logic and the absent-file guard; the live builder tree and the
// resolved sdkconfig are exercised by the CI build and scripts/0014-verify.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendDefconfigLines, applyAddedDefconfigLines } from '../scripts/build.mjs';

// A fragment shaped like configs/defconfig.esp32: plain CONFIG_ assignment lines, trailing newline.
const DEFCONFIG_ESP32 = [
  'CONFIG_BT_ENABLED=y',
  'CONFIG_SPIRAM=y',
  'CONFIG_SPIRAM_OCCUPY_HSPI_HOST=y',
  'CONFIG_FREERTOS_TIMER_TASK_STACK_DEPTH=4096',
  '',
].join('\n');

test('appendDefconfigLines appends the line and preserves every stock line, single trailing newline', () => {
  const out = appendDefconfigLines(DEFCONFIG_ESP32, ['CONFIG_ESP32_REV_MIN_3=y']);
  assert.ok(/^CONFIG_ESP32_REV_MIN_3=y$/m.test(out), 'the rev-min line is appended');
  // Every stock line survives, in order, unchanged.
  for (const stock of ['CONFIG_BT_ENABLED=y', 'CONFIG_SPIRAM=y', 'CONFIG_SPIRAM_OCCUPY_HSPI_HOST=y', 'CONFIG_FREERTOS_TIMER_TASK_STACK_DEPTH=4096']) {
    assert.ok(out.includes(stock), `stock line preserved: ${stock}`);
  }
  assert.ok(out.endsWith('CONFIG_ESP32_REV_MIN_3=y\n'), 'exactly one terminating newline, line last');
  assert.ok(!out.endsWith('\n\n'), 'no doubled trailing newline');
});

test('appendDefconfigLines normalises zero or multiple trailing newlines to one', () => {
  const noNl = appendDefconfigLines('CONFIG_A=y', ['CONFIG_B=y']);
  assert.equal(noNl, 'CONFIG_A=y\nCONFIG_B=y\n');
  const manyNl = appendDefconfigLines('CONFIG_A=y\n\n\n', ['CONFIG_B=y']);
  assert.equal(manyNl, 'CONFIG_A=y\nCONFIG_B=y\n');
});

test('appendDefconfigLines appends several lines in order', () => {
  const out = appendDefconfigLines('CONFIG_A=y\n', ['CONFIG_B=y', 'CONFIG_C=y']);
  assert.equal(out, 'CONFIG_A=y\nCONFIG_B=y\nCONFIG_C=y\n');
});

test('appendDefconfigLines fails loud when the exact line is already present', () => {
  const already = `${DEFCONFIG_ESP32}CONFIG_ESP32_REV_MIN_3=y\n`;
  assert.throws(() => appendDefconfigLines(already, ['CONFIG_ESP32_REV_MIN_3=y']), /already present/);
});

test('appendDefconfigLines fails loud when the symbol is present with a different value (clash)', () => {
  // Upstream started setting the symbol to a different value: our append would conflict, so surface it.
  const clash = 'CONFIG_ESP32_REV_MIN_3=n\n';
  assert.throws(() => appendDefconfigLines(clash, ['CONFIG_ESP32_REV_MIN_3=y']), /ESP32_REV_MIN_3.*already present/);
});

test('appendDefconfigLines fails loud when the symbol is present as an "is not set" comment', () => {
  const notSet = '# CONFIG_ESP32_REV_MIN_3 is not set\n';
  assert.throws(() => appendDefconfigLines(notSet, ['CONFIG_ESP32_REV_MIN_3=y']), /already present/);
});

test('appendDefconfigLines does not false-clash on a different symbol sharing a prefix', () => {
  // CONFIG_ESP32_REV_MIN_0 is a different choice option; appending _3 must not be blocked by it.
  const out = appendDefconfigLines('CONFIG_ESP32_REV_MIN_0=y\n', ['CONFIG_ESP32_REV_MIN_3=y']);
  assert.ok(out.includes('CONFIG_ESP32_REV_MIN_0=y') && out.includes('CONFIG_ESP32_REV_MIN_3=y'));
});

test('appendDefconfigLines catches a clash written in variant forms (CRLF, indent, spaced equals)', () => {
  // The guard exists to fail loud when upstream starts setting the symbol; it must not be slipped by a
  // non-canonical line format. Each of these already sets CONFIG_ESP32_REV_MIN_3 and must block the append.
  for (const variant of [
    '# CONFIG_ESP32_REV_MIN_3 is not set\r\n', // CRLF
    '  # CONFIG_ESP32_REV_MIN_3 is not set\n', // indented comment
    '#CONFIG_ESP32_REV_MIN_3 is not set\n', // no space after #
    '  CONFIG_ESP32_REV_MIN_3=n\n', // indented assignment
    'CONFIG_ESP32_REV_MIN_3 = n\n', // spaced equals
  ]) {
    assert.throws(() => appendDefconfigLines(variant, ['CONFIG_ESP32_REV_MIN_3=y']), /already present/, `variant must clash: ${JSON.stringify(variant)}`);
  }
});

test('appendDefconfigLines rejects an appended line that is not a well-formed config line', () => {
  for (const bad of ['', '# just a prose comment', 'not a config line', 'FOO=1']) {
    assert.throws(() => appendDefconfigLines('CONFIG_A=y\n', [bad]), /not a CONFIG_ assignment or "is not set" line/);
  }
});

test('appendDefconfigLines does not misread a prose comment or blank line as a symbol', () => {
  // A blank line and a prose comment in the file must not be treated as symbols (they would have
  // mis-collided under the old symbol-agnostic extraction). The append still succeeds.
  const withNoise = 'CONFIG_A=y\n\n# a human note about CONFIG_A\n';
  const out = appendDefconfigLines(withNoise, ['CONFIG_ESP32_REV_MIN_3=y']);
  assert.ok(out.includes('CONFIG_ESP32_REV_MIN_3=y'));
  assert.ok(out.includes('# a human note about CONFIG_A'), 'the prose comment is preserved');
});

test('appendDefconfigLines on empty input adds no spurious leading blank line', () => {
  assert.equal(appendDefconfigLines('', ['CONFIG_X=y']), 'CONFIG_X=y\n');
});

test('appendDefconfigLines rejects a duplicate symbol within the appended batch itself', () => {
  assert.throws(() => appendDefconfigLines('CONFIG_A=y\n', ['CONFIG_B=y', 'CONFIG_B=n']), /CONFIG_B already present/);
});

test('applyAddedDefconfigLines appends to the keyed file on disk and leaves others untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revmin-'));
  try {
    writeFileSync(join(dir, 'defconfig.esp32'), DEFCONFIG_ESP32);
    writeFileSync(join(dir, 'defconfig.esp32s3'), 'CONFIG_IDF_TARGET_ESP32S3=y\n');
    applyAddedDefconfigLines(dir, { 'defconfig.esp32': ['CONFIG_ESP32_REV_MIN_3=y'] });
    assert.ok(readFileSync(join(dir, 'defconfig.esp32'), 'utf8').includes('CONFIG_ESP32_REV_MIN_3=y'), 'esp32 got the line');
    assert.equal(readFileSync(join(dir, 'defconfig.esp32s3'), 'utf8'), 'CONFIG_IDF_TARGET_ESP32S3=y\n', 'esp32s3 untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAddedDefconfigLines fails loud, naming the file, when a keyed target is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revmin-'));
  try {
    assert.throws(
      () => applyAddedDefconfigLines(dir, { 'defconfig.esp32': ['CONFIG_ESP32_REV_MIN_3=y'] }),
      /defconfig\.esp32 not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAddedDefconfigLines is a no-op for an empty or undefined map', () => {
  assert.doesNotThrow(() => applyAddedDefconfigLines('/nonexistent', {}));
  assert.doesNotThrow(() => applyAddedDefconfigLines('/nonexistent', undefined));
});
