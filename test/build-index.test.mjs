// Regression tests for the markdown-cell escaping in scripts/build-index.mjs. The index is
// generated from ADR frontmatter, so a title carrying a table meta-character (`|`) or a
// backslash must be escaped or it corrupts the generated table (CWE-116, incomplete
// sanitization). These fail if the escaping drops either character or orders them wrongly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cell, renderIndex } from '../scripts/build-index.mjs';

const doc = (data) => ({ ok: true, data });

test('cell escapes a lone pipe so it cannot split a row', () => {
  assert.equal(cell('a|b'), 'a\\|b');
});

test('cell escapes the backslash itself, first, so it cannot consume the next escape', () => {
  // Pre-fix (pipe-only) yields 'a\b\|c': the lone backslash is left raw and markdown reads
  // it as escaping the 'b'. The backslash must be doubled, which requires escaping it first.
  assert.equal(cell('a\\b|c'), 'a\\\\b\\|c');
});

test('cell leaves ordinary titles untouched', () => {
  assert.equal(cell('fork model and release shape'), 'fork model and release shape');
});

test('renderIndex emits the escaped title in the table row', () => {
  const text = renderIndex([
    doc({ id: '1', title: 'pin a\\b | guard', type: 'architecture', status: 'accepted' }),
  ]);
  assert.ok(text.includes('pin a\\\\b \\| guard'), text);
});
