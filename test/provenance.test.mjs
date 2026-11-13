// Regression tests for the shared provenance primitives (scripts/lib/provenance.mjs). These guard the
// slice-0002 adversarial-pass fixes so a later refactor cannot silently reverse them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EMPTY_STACK_SENTINEL, patchStack } from '../scripts/lib/provenance.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'adv-provenance-'));
}

test('EMPTY_STACK_SENTINEL is the documented SHA-256 of empty input', () => {
  assert.equal(
    EMPTY_STACK_SENTINEL,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
});

test('patchStack on a missing directory resolves to the empty-stack sentinel', () => {
  const r = patchStack(join(tempDir(), 'does-not-exist'));
  assert.equal(r.hash, EMPTY_STACK_SENTINEL);
  assert.equal(r.count, 0);
  assert.deepEqual(r.files, []);
});

test('patchStack on an empty directory resolves to the empty-stack sentinel', () => {
  const dir = tempDir();
  try {
    const r = patchStack(dir);
    assert.equal(r.hash, EMPTY_STACK_SENTINEL);
    assert.equal(r.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patchStack ignores non-.patch files', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'README.md'), 'not a patch');
    writeFileSync(join(dir, '0001-x.patch'), 'real patch');
    const r = patchStack(dir);
    assert.equal(r.count, 1);
    assert.deepEqual(r.files, ['0001-x.patch']);
    assert.notEqual(r.hash, EMPTY_STACK_SENTINEL);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// F10: each file is framed with name + byte length before its content, so a byte moved across the
// boundary between two adjacent patches changes the hash. Under a bare content concatenation these two
// stacks are identical ("XY" either way); framed, they must differ. Fails if the framing is dropped.
test('patchStack framing detects a byte shifted across a patch boundary', () => {
  const dirA = tempDir();
  const dirB = tempDir();
  try {
    writeFileSync(join(dirA, 'a.patch'), 'XY');
    writeFileSync(join(dirA, 'b.patch'), '');
    writeFileSync(join(dirB, 'a.patch'), 'X');
    writeFileSync(join(dirB, 'b.patch'), 'Y');
    assert.notEqual(patchStack(dirA).hash, patchStack(dirB).hash);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// Filename order, not directory-listing order, must drive the hash: renaming a patch changes it.
test('patchStack hashes files in sorted filename order and includes the name', () => {
  const dir1 = tempDir();
  const dir2 = tempDir();
  try {
    writeFileSync(join(dir1, '0001-a.patch'), 'same body');
    writeFileSync(join(dir2, '0002-a.patch'), 'same body');
    assert.notEqual(patchStack(dir1).hash, patchStack(dir2).hash);
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});
