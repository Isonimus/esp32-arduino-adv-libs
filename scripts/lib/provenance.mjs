// Shared provenance primitives for slice-0002. The patch-stack hash is written by the build
// (scripts/build.mjs, the producer) and checked by the verify (scripts/0002-verify.mjs, the
// consumer): if the two computed it independently they could drift, and Scenario D's check would
// silently stop meaning anything. One definition, imported by both, is the only honest arrangement.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// SHA-256 of empty input: the content hash of an ordered patch stack with zero files. A documented
// constant, so the v0.0.1 baseline is never a magic value (CLAUDE.md section 3).
export const EMPTY_STACK_SENTINEL = createHash('sha256').update('').digest('hex');

// Content hash over the ordered *.patch files in filename order (ADR-0001 section 4). Each file is
// framed with its name and byte length before its content, so a rename, a reorder, or a byte moved
// across the boundary between two adjacent patches all change the hash (a bare concatenation would
// hide those). Zero files resolves to the empty-stack sentinel: the v0.0.1 unpatched baseline.
export function patchStack(patchesDir) {
  if (!existsSync(patchesDir)) return { hash: EMPTY_STACK_SENTINEL, count: 0, files: [] };
  const files = readdirSync(patchesDir).filter((f) => f.endsWith('.patch')).sort();
  if (files.length === 0) return { hash: EMPTY_STACK_SENTINEL, count: 0, files: [] };
  const h = createHash('sha256');
  for (const f of files) {
    const content = readFileSync(join(patchesDir, f));
    h.update(`${f}\0${content.length}\0`);
    h.update(content);
  }
  return { hash: h.digest('hex'), count: files.length, files };
}
