// Regression tests for the in-container arduino-manifest remover (scripts/overlay/strip-manifest-components.py,
// slice-0012 / ADR-0011). It runs in the build container (python3, no node), so it is tested here by
// spawning python3, which the CI runner has, against a fixture shaped like arduino-esp32's manifest:
// nested keys with version/require/rules blocks, interleaved comments, blank lines. This proves the
// real artifact removes exactly the named blocks and fails loud (non-zero, naming the component) on an
// absent one, the same contract as removeManagedComponents in build.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'overlay', 'strip-manifest-components.py');

const FIXTURE = `dependencies:
  idf: ">=5.3,<5.6"
  espressif/mdns:
    version: "^1.2.3"
    require: public
  espressif/esp-zboss-lib:
    version: "==1.6.4" # trailing comment
    require: public
    rules:
      - if: "target not in [esp32c2]"
  # RainMaker Start
  espressif/esp_rainmaker:
    version: "1.5.2"
    rules:
      - if: "target != esp32c2"
  espressif/cbor:
    version: "0.6.1~4"
  # RainMaker End
  espressif/libsodium:
    version: "^1.0.20~1"
    require: public
`;

function runStrip(manifestText, components) {
  const dir = mkdtempSync(join(tmpdir(), 'strip-test-'));
  const file = join(dir, 'idf_component.yml');
  try {
    writeFileSync(file, manifestText);
    const res = spawnSync('python3', [SCRIPT, file, ...components], { encoding: 'utf8' });
    const out = res.status === 0 ? readFileSync(file, 'utf8') : null;
    return { status: res.status, stderr: res.stderr, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('removes each named component block, preserving the kept components and the file around them', () => {
  const { status, out } = runStrip(FIXTURE, ['espressif/esp-zboss-lib', 'espressif/esp_rainmaker', 'espressif/cbor']);
  assert.equal(status, 0);
  assert.ok(!/^\s+espressif\/esp-zboss-lib:/m.test(out), 'esp-zboss-lib block removed');
  assert.ok(!/^\s+espressif\/esp_rainmaker:/m.test(out), 'esp_rainmaker block removed');
  assert.ok(!/^\s+espressif\/cbor:/m.test(out), 'cbor block removed');
  // Its nested lines go with it (no orphaned "require: public" / "rules:" left behind).
  assert.ok(!out.includes('target not in [esp32c2]'), "esp-zboss-lib's rule line removed with the block");
  // Kept components and their nested keys survive intact.
  assert.ok(/^\s+espressif\/mdns:/m.test(out), 'mdns kept');
  assert.ok(/^\s+espressif\/libsodium:/m.test(out), 'libsodium kept');
  assert.ok(out.includes('version: "^1.0.20~1"'), "libsodium's version line kept");
  assert.ok(out.includes('idf: ">=5.3,<5.6"'), 'the idf constraint is untouched');
});

test('fails loud (non-zero, naming the component) when a named component is absent', () => {
  const { status, stderr } = runStrip(FIXTURE, ['espressif/not-here']);
  assert.notEqual(status, 0);
  assert.match(stderr, /espressif\/not-here.*not found/);
});

test('an absent component in a list aborts the whole run rather than partially editing', () => {
  // esp-zboss-lib exists, bogus does not: the run must fail, and because it fails on the second name
  // the caller treats the file as not-reliably-edited (build.sh exits on non-zero).
  const { status } = runStrip(FIXTURE, ['espressif/esp-zboss-lib', 'espressif/bogus']);
  assert.notEqual(status, 0);
});

test('preserves CRLF line endings byte-for-byte (no universal-newline rewrite)', () => {
  const crlf = FIXTURE.replace(/\n/g, '\r\n');
  const { status, out } = runStrip(crlf, ['espressif/cbor']);
  assert.equal(status, 0);
  assert.ok(out.includes('\r\n'), 'CRLF endings must survive');
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF should be introduced');
  assert.ok(!/^\s+espressif\/cbor:/m.test(out), 'the targeted block is still removed under CRLF');
});
