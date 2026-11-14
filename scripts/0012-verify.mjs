#!/usr/bin/env node
// Verify (slice-0012, ADR-0011 / repo rule 3). The unattended error-gate half of the slim's proof:
// given the built release zip, it asserts that each enabled chip's resolved dependency tree
// (<chip>/dependencies.lock inside the zip) contains NONE of the removed components and still contains
// the kept ones. "Both chips build green" is the other half, proven by the CI matrix; this proves the
// removal actually took effect (a component dropped from a manifest but pulled back transitively would
// reappear here), and guards against a future change re-introducing one (CLAUDE.md section 4 invariant 7).
//
//   node scripts/0012-verify.mjs <built-release.zip>
//
// It reads the removed sets and enabled chips from UPSTREAM.lock (single source of truth) and writes
// the per-chip findings to .verify-out/ for human review; the pass/fail decision is fully automatic.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDependenciesLock } from './lib/dependencies-lock.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0012-slim.json');

// A representative sample of components kept for the consumers, present on both enabled chips (none is
// target-gated off esp32/esp32s3). Not exhaustive: enough that "the lock resolved to something real,
// not an empty or broken tree" is proven alongside the removals. Removing one of these from the build
// would fail this check, catching an over-broad future removal.
const KEPT_SENTINELS = [
  'espressif/mdns',
  'espressif/libsodium',
  'espressif/esp-modbus',
  'joltwallet/littlefs',
];

function extractDependenciesLock(zipPath, chip) {
  const entry = `${chip}/dependencies.lock`;
  let text;
  try {
    text = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0012-verify: could not read ${entry} from ${zipPath} (is the chip built and packaged?)`, { cause });
  }
  if (!text.trim()) throw new Error(`0012-verify: ${entry} is empty in ${zipPath}`);
  return text;
}

function main(argv) {
  const zipPath = argv[2];
  if (!zipPath) throw new Error('usage: node scripts/0012-verify.mjs <built-release.zip>');
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const removed = [...(lock.removedComponents ?? []), ...(lock.removedArduinoComponents ?? [])];
  const chips = lock.enabledChips ?? [];
  if (!removed.length) throw new Error('0012-verify: UPSTREAM.lock lists no removed components; nothing to prove (did the lock lose its slim?)');

  const results = chips.map((chip) => checkDependenciesLock(extractDependenciesLock(zipPath, chip), chip, { removed, kept: KEPT_SENTINELS }));
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ zip: zipPath, removed, kept: KEPT_SENTINELS, results }, null, 2)}\n`);

  let failed = false;
  for (const { chip, offenders, missing } of results) {
    if (offenders.length) {
      failed = true;
      console.error(`FAIL  ${chip}: removed component(s) still resolved: ${offenders.join(', ')}`);
    }
    if (missing.length) {
      failed = true;
      console.error(`FAIL  ${chip}: kept component(s) missing from the resolved tree: ${missing.join(', ')}`);
    }
    if (!offenders.length && !missing.length) {
      console.log(`ok    ${chip}: ${removed.length} removed component(s) absent, ${KEPT_SENTINELS.length} kept sentinel(s) present`);
    }
  }
  if (failed) {
    console.error(`slim verification failed; see ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`slim verified across ${chips.length} chip(s); findings in ${OUT_PATH}`);
}

main(process.argv);
