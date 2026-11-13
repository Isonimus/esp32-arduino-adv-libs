#!/usr/bin/env node
// Probe (ADR-0001 / repo rule 3): measures the drop-in-parity reference ONCE and writes it
// to reference/bruce-blob-layout.json, which is committed and consumed by scripts/0002-verify.mjs.
// It is a probe, not a standing regression check, so it is intentionally not wired into the
// CI gate: the committed reference is the artifact, and verify compares against that offline.
//
// Why it range-reads instead of downloading: the Bruce blob is ~576 MB, but a zip's central
// directory (a few MB) at the tail lists every entry. Reading only the End-Of-Central-Directory
// record plus the central directory yields the complete layout from a few KB of transfer, so the
// parity reference rests on the real artifact (CLAUDE.md section 3) without moving half a gigabyte.
//
// Re-run with `npm run probe:bruce-blob` to re-measure after the pinned reference blob changes.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(REPO_ROOT, 'reference', 'bruce-blob-layout.json');

const EOCD_SIG = 0x06054b50; // End of Central Directory record
const CEN_SIG = 0x02014b50; // Central directory file header
const MAX_EOCD_SCAN = 65557; // 22-byte EOCD + max 65535-byte trailing comment
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

function readLock() {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'UPSTREAM.lock'), 'utf8'));
  const { url, sizeBytes } = lock.referenceBlob;
  if (!url || !sizeBytes) throw new Error('UPSTREAM.lock referenceBlob is missing url or sizeBytes');
  if (!Array.isArray(lock.enabledChips) || lock.enabledChips.length === 0) {
    throw new Error('UPSTREAM.lock enabledChips is empty');
  }
  return { url, sizeBytes, enabledChips: lock.enabledChips };
}

async function range(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error(`expected HTTP 206 for byte range, got ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function listEntries(url, size) {
  const tail = await range(url, size - Math.min(MAX_EOCD_SCAN, size), size - 1);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('End-Of-Central-Directory record not found in blob tail');

  const totalEntries = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === U32_MAX || cdSize === U32_MAX || totalEntries === U16_MAX) {
    throw new Error('ZIP64 markers present; this probe only handles classic zip (the reference blob is < 4 GB)');
  }
  if (totalEntries === 0 || cdSize === 0) throw new Error('zip has no entries');

  const cd = await range(url, cdOffset, cdOffset + cdSize - 1);
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
    throw new Error(`central directory parse mismatch: EOCD claims ${totalEntries} entries, parsed ${names.length}`);
  }
  return names;
}

// First path segment of every entry, suffixed with '/' for directories. This is the drop-in
// surface: the zip root becomes the PlatformIO package dir, so these are what a consumer sees.
function topLevel(names) {
  const top = new Set();
  for (const n of names) {
    const slash = n.indexOf('/');
    top.add(slash === -1 ? n : n.slice(0, slash) + '/');
  }
  return [...top].sort();
}

// Immediate children of `<chip>/`, each suffixed '/' for a subdir. The per-chip subtree root
// shape the DoD Scenario A compares against.
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

async function main() {
  const { url, sizeBytes, enabledChips } = readLock();

  const head = await fetch(url, { method: 'HEAD' });
  const actualSize = Number(head.headers.get('content-length'));
  if (!actualSize) throw new Error('reference blob HEAD returned no content-length');
  if (actualSize !== sizeBytes) {
    throw new Error(`reference blob size changed: UPSTREAM.lock pins ${sizeBytes}, server reports ${actualSize}. The pinned blob must be immutable; investigate before re-measuring.`);
  }

  const names = await listEntries(url, actualSize);
  const top = topLevel(names);
  const files = top.filter((e) => !e.endsWith('/'));
  const dirs = top.filter((e) => e.endsWith('/'));

  const enabledChipMembers = {};
  for (const chip of enabledChips) {
    if (!dirs.includes(chip + '/')) {
      throw new Error(`enabled chip "${chip}" has no top-level dir in the reference blob`);
    }
    enabledChipMembers[chip] = chipMembers(names, chip);
  }

  const reference = {
    comment: 'GENERATED by scripts/bruce-blob-shape-probe.mjs from the pinned reference blob (ADR-0001). The drop-in-parity reference for slice-0002 Scenario A. Do not hand-edit; re-run the probe to regenerate.',
    source: {
      url,
      sizeBytes: actualSize,
      measuredOn: new Date().toISOString().slice(0, 10),
      entryCount: names.length,
    },
    topLevelFiles: files,
    topLevelDirs: dirs,
    enabledChipMembers,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(reference, null, 2) + '\n');
  console.log(`Wrote ${OUT_PATH}`);
  console.log(`  ${names.length} entries; top-level files ${JSON.stringify(files)}`);
  console.log(`  top-level dirs ${JSON.stringify(dirs)}`);
  for (const chip of enabledChips) {
    console.log(`  ${chip}/ -> ${JSON.stringify(enabledChipMembers[chip])}`);
  }
}

await main();
