#!/usr/bin/env node
// Resolved-dependency drift gate (slice-0027, ADR-0026). The achievable half of ADR-0001 section 6's
// reproducibility contract: given the built release zip, assert that each enabled chip's resolved
// dependency tree (<chip>/dependencies.lock inside the zip) still matches the committed snapshot under
// reference/. The component manager resolves the transitive tree (esp-dsp, esp-modbus, the kept arduino
// deps, ...) at build time; nothing pinned it, so a rebuild could silently pull a newer transitive
// component. This fails loud, with a per-component diff, the moment the resolved versions or content
// hashes drift, so the drift becomes a reviewed, re-blessed change rather than a silent one.
//
//   node scripts/0027-verify.mjs <built-release.zip>
//
// The byte-for-byte artifact compare ADR-0001 section 6 first named is withdrawn (ADR-0026): the zip
// name and manifest carry the build date, and the builder image apt/pip layers and the IDF/GCC build
// are not bit-pinned, so a raw compare is defeated before any toolchain question. This gates the
// provenance-meaningful projection (versions + component_hash + target + direct deps) instead.
//
// Enabled chips come from UPSTREAM.lock (single source of truth). Findings are written to .verify-out/
// for human review; the pass/fail decision is fully automatic. Fails loud if a chip's committed snapshot
// is absent: a drift gate with no baseline is not a gate (see ## As built in the slice for the bootstrap
// that captures the snapshot from the first green build).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDependenciesLock, diffDependencyLocks } from './lib/dependencies-lock.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const SNAPSHOT_DIR = join(REPO_ROOT, 'reference');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0027-deps-lock.json');

function snapshotPath(chip) {
  return join(SNAPSHOT_DIR, `dependencies.lock.${chip}`);
}

function extractDependenciesLock(zipPath, chip) {
  const entry = `${chip}/dependencies.lock`;
  let text;
  try {
    text = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0027-verify: could not read ${entry} from ${zipPath} (is the chip built and packaged?)`, { cause });
  }
  if (!text.trim()) throw new Error(`0027-verify: ${entry} is empty in ${zipPath}`);
  return text;
}

function main(argv) {
  const zipPath = argv[2];
  if (!zipPath) throw new Error('usage: node scripts/0027-verify.mjs <built-release.zip>');
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const chips = lock.enabledChips ?? [];
  if (!chips.length) throw new Error('0027-verify: UPSTREAM.lock lists no enabledChips');

  const results = [];
  let failed = false;
  for (const chip of chips) {
    const snapPath = snapshotPath(chip);
    if (!existsSync(snapPath)) {
      // A missing snapshot is not a pass: there is no baseline to gate against. Recorded as this chip's
      // failure (not thrown) so every chip still reports in one run, matching how drift and 0012-verify
      // accumulate; the run is still red. Capturing the snapshot is the bootstrap (slice-0027 ## As built),
      // done once from the first green build's artifact.
      failed = true;
      results.push({ chip, missingSnapshot: true, diffs: [] });
      console.error(`FAIL  ${chip}: no committed snapshot at reference/dependencies.lock.${chip}; capture it from a green build before this gate can pass (slice-0027 bootstrap)`);
      continue;
    }
    const expected = projectDependenciesLock(readFileSync(snapPath, 'utf8'), { chip });
    const actual = projectDependenciesLock(extractDependenciesLock(zipPath, chip), { chip });
    const diffs = diffDependencyLocks(expected, actual);
    results.push({ chip, componentCount: Object.keys(actual.components).length, diffs });
    if (diffs.length) {
      failed = true;
      console.error(`FAIL  ${chip}: resolved dependency tree drifted from reference/dependencies.lock.${chip}:`);
      for (const d of diffs) console.error(`        - ${d}`);
      console.error(`      If this drift is intended, re-bless the snapshot: unzip -p ${zipPath} ${chip}/dependencies.lock > reference/dependencies.lock.${chip}`);
    } else {
      console.log(`ok    ${chip}: ${results.at(-1).componentCount} resolved component(s) match the committed snapshot`);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ zip: zipPath, results }, null, 2)}\n`);

  if (failed) {
    console.error(`dependency-drift verification failed; see ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`dependency tree verified across ${chips.length} chip(s); findings in ${OUT_PATH}`);
}

main(process.argv);
