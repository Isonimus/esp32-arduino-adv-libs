#!/usr/bin/env node
// Verify (slice-0002, ADR-0001 / repo rule 3). The unattended error-gate half of the slice's
// proof: given the built release zip and its manifest, it asserts the three machine-checkable
// Definition-of-Done scenarios and exits nonzero on any failure, so CI fails the release rather
// than shipping a mis-shaped artifact. It writes the observed-vs-expected layout to .verify-out/
// for human review (rule 3), but the pass/fail decision is fully automatic.
//
//   node scripts/0002-verify.mjs <built-release.zip> <manifest.json>
//
// Scenario A: the zip is a drop-in for the Bruce blob at the DoD's granularity (top-level entries
//   and per-chip subtree roots) against the committed reference/bruce-blob-layout.json.
// Scenario C: the manifest carries all five pins non-empty plus the zip's SHA-256.
// Scenario D: the patch stack is the empty baseline (patches/ empty, manifest hash == sentinel).
//
// It is NOT a byte-for-byte check: that is the reproducibility gate (ADR-0001 section 6), a
// different claim. This checks shape, which is what makes the URL swap resolve to the same package.

import { createHash } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMPTY_STACK_SENTINEL, patchStack } from './lib/provenance.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REFERENCE_PATH = join(REPO_ROOT, 'reference', 'bruce-blob-layout.json');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const PATCHES_DIR = join(REPO_ROOT, 'patches');
const DIFF_OUT = join(REPO_ROOT, '.verify-out', '0002-shape.json');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const MAX_EOCD_SCAN = 65557;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

// List every entry name in a local zip by reading only its tail (EOCD) and central directory,
// so a tens-of-MB artifact is inspected without reading the whole file into memory.
function listLocalZip(zipPath) {
  const size = statSync(zipPath).size;
  const fd = openSync(zipPath, 'r');
  try {
    const tailLen = Math.min(MAX_EOCD_SCAN, size);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error(`${zipPath}: End-Of-Central-Directory record not found (not a zip?)`);

    const totalEntries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === U32_MAX || cdSize === U32_MAX || totalEntries === U16_MAX) {
      throw new Error(`${zipPath}: ZIP64 markers present; this verifier handles classic zip only`);
    }
    if (totalEntries === 0 || cdSize === 0) throw new Error(`${zipPath}: zip has no entries`);

    const cd = Buffer.alloc(cdSize);
    readSync(fd, cd, 0, cdSize, cdOffset);
    const names = [];
    let p = 0;
    while (p + 46 <= cd.length && cd.readUInt32LE(p) === CEN_SIG) {
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (names.length !== totalEntries) {
      throw new Error(`${zipPath}: central directory parse mismatch (EOCD ${totalEntries}, parsed ${names.length})`);
    }
    return names;
  } finally {
    closeSync(fd);
  }
}

function topLevel(names) {
  const files = new Set();
  const dirs = new Set();
  for (const n of names) {
    const slash = n.indexOf('/');
    if (slash === -1) files.add(n);
    else dirs.add(n.slice(0, slash) + '/');
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

function chipMembers(names, chip) {
  const prefix = chip + '/';
  const members = new Set();
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const rest = n.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    members.add(slash === -1 ? rest : rest.slice(0, slash) + '/');
  }
  return [...members].sort();
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function main() {
  const [zipPath, manifestPath] = process.argv.slice(2);
  if (!zipPath || !manifestPath) {
    throw new Error('usage: node scripts/0002-verify.mjs <built-release.zip> <manifest.json>');
  }

  const reference = JSON.parse(readFileSync(REFERENCE_PATH, 'utf8'));
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const enabledChips = Object.keys(reference.enabledChipMembers);

  const names = listLocalZip(zipPath);
  const built = topLevel(names);
  const failures = [];

  // --- Scenario A: drop-in shape parity ---
  // Parity is scoped to the enabled chips, NOT identity with the Bruce blob: the blob ships ~12
  // chips, we ship only the ones the two consumers build (ADR-0001 section 5). A consumer pinning
  // our zip for an esp32/esp32s3 board needs exactly those subtrees plus the shared files, so our
  // top-level is a strict subset of the blob's. Do not "fix" this to require every blob chip.
  // Shared files: every reference top-level file must be present.
  for (const f of reference.topLevelFiles) {
    if (!built.files.includes(f)) failures.push(`A: missing top-level file "${f}"`);
  }
  // Top-level dirs: exactly one per enabled chip, each a dir the reference also ships, no extras.
  const expectedDirs = enabledChips.map((c) => c + '/').sort();
  if (!sameSet(built.dirs, expectedDirs)) {
    failures.push(`A: top-level dirs ${JSON.stringify(built.dirs)} != enabled ${JSON.stringify(expectedDirs)}`);
  }
  for (const d of built.dirs) {
    if (!reference.topLevelDirs.includes(d)) failures.push(`A: top-level dir "${d}" is not in the reference blob`);
  }
  // No unexpected top-level files beyond the reference's shared files.
  for (const f of built.files) {
    if (!reference.topLevelFiles.includes(f)) failures.push(`A: unexpected top-level file "${f}"`);
  }
  // Per-chip subtree roots must match the reference exactly.
  const observedChipMembers = {};
  for (const chip of enabledChips) {
    const members = chipMembers(names, chip);
    observedChipMembers[chip] = members;
    const expected = reference.enabledChipMembers[chip];
    if (!sameSet(members, expected)) {
      failures.push(`A: ${chip}/ members ${JSON.stringify(members)} != reference ${JSON.stringify(expected)}`);
    }
  }

  // --- Scenario C: five-pin provenance manifest + zip SHA-256 ---
  // Each pin must be present AND well-formed: a non-empty check alone passes "undefined" or "x",
  // which defeats the point of recording the pin. Shapes match what build.mjs writes: the builder
  // commit is a full 40-hex sha and equals the lock; the resolved commits are shorter shas read
  // from versions.txt; the image digest is a sha256 ref.
  const PIN_SHAPES = {
    upstreamBuilderCommit: /^[0-9a-f]{40}$/,
    resolvedIdfCommit: /^[0-9a-f]{7,40}$/,
    resolvedArduinoCommit: /^[0-9a-f]{7,40}$/,
    patchStackHash: /^[0-9a-f]{64}$/,
    builderImageDigest: /^sha256:[0-9a-f]{64}$/,
  };
  for (const [pin, shape] of Object.entries(PIN_SHAPES)) {
    const v = manifest.pins?.[pin];
    if (!v || String(v).trim() === '') failures.push(`C: manifest pin "${pin}" is missing or empty`);
    else if (!shape.test(v)) failures.push(`C: manifest pin "${pin}"="${v}" is malformed (expected ${shape})`);
  }
  if (manifest.pins?.upstreamBuilderCommit && manifest.pins.upstreamBuilderCommit !== lock.upstream.commit) {
    failures.push(`C: manifest upstreamBuilderCommit ${manifest.pins.upstreamBuilderCommit} != UPSTREAM.lock ${lock.upstream.commit}`);
  }
  if (manifest.artifact?.name !== basename(zipPath)) {
    failures.push(`C: manifest artifact.name "${manifest.artifact?.name}" != zip basename "${basename(zipPath)}"`);
  }
  if (!sameSet(manifest.artifact?.chips ?? [], enabledChips)) {
    failures.push(`C: manifest artifact.chips ${JSON.stringify(manifest.artifact?.chips)} != enabled ${JSON.stringify(enabledChips)}`);
  }
  const declaredSha = manifest.artifact?.sha256;
  if (!declaredSha) {
    failures.push('C: manifest artifact.sha256 is missing');
  } else if (sha256File(zipPath) !== declaredSha) {
    failures.push(`C: manifest sha256 ${declaredSha} != actual ${sha256File(zipPath)}`);
  }

  // --- Scenario D: empty baseline stack ---
  // This verifier is specific to v0.0.1, the unpatched baseline, so it asserts patches/ is empty
  // AND the manifest hash is the sentinel. A later release with a real stack ships its own verify;
  // do not relax this one to let patches through. The recomputed-hash check below is the general
  // producer/consumer agreement (invariant 5): the manifest must match what patchStack() computes
  // here from the same patches/, whether or not that is the sentinel.
  const stack = patchStack(PATCHES_DIR);
  if (manifest.pins?.patchStackHash !== stack.hash) {
    failures.push(`D: manifest patchStackHash ${manifest.pins?.patchStackHash} != recomputed ${stack.hash}`);
  }
  if (stack.count !== 0) failures.push(`D: patches/ holds ${stack.count} patch(es); v0.0.1 baseline must be empty`);
  if (manifest.pins?.patchStackHash !== EMPTY_STACK_SENTINEL) {
    failures.push(`D: manifest patchStackHash ${manifest.pins?.patchStackHash} != empty-stack sentinel ${EMPTY_STACK_SENTINEL}`);
  }

  // Artifact for human review (rule 3).
  mkdirSync(dirname(DIFF_OUT), { recursive: true });
  writeFileSync(DIFF_OUT, JSON.stringify({
    zip: zipPath,
    enabledChips,
    observed: { topLevel: built, chipMembers: observedChipMembers },
    reference: { topLevelFiles: reference.topLevelFiles, enabledChipMembers: reference.enabledChipMembers },
    failures,
  }, null, 2) + '\n');

  if (failures.length > 0) {
    console.error(`slice-0002 verify FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(`observed-vs-expected written to ${DIFF_OUT}`);
    process.exit(1);
  }
  console.log(`slice-0002 verify OK: drop-in shape parity, five-pin manifest, empty baseline (${enabledChips.join(', ')})`);
}

main();
