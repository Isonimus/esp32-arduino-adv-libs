#!/usr/bin/env node
// Verify (slice-0014, ADR-0013 / repo rule 3). The unattended error-gate half of the esp32 REV_MIN
// fix: given the built release zip, it asserts that each chip we appended a defconfig line for carries
// that line in its RESOLVED <chip>/sdkconfig, and that esp32 specifically no longer carries the PSRAM
// cache workaround (CONFIG_SPIRAM_CACHE_WORKAROUND), whose IRAM-resident libc overflowed esp32 IRAM
// before the fix. "Both chips build green" and "m5stick links" are the other halves (CI matrix and the
// As-built re-trial); this proves the append took effect in the shipped config and guards against a
// future change dropping it or re-introducing the workaround (CLAUDE.md section 4 invariant 8).
//
//   node scripts/0014-verify.mjs <built-release.zip>
//
// It reads addedDefconfigLines from UPSTREAM.lock (single source of truth) and writes the per-chip
// findings to .verify-out/ for human review; the pass/fail decision is fully automatic.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0014-rev-min.json');

// The ESP32 PSRAM cache workaround (ADR-0013): auto-forced at REV_MIN < 3 with PSRAM, it relocates
// libc into IRAM. Its absence in the resolved esp32 config is the measurable consequence of REV_MIN=3.
const CACHE_WORKAROUND = 'CONFIG_SPIRAM_CACHE_WORKAROUND=y';

function extractSdkconfig(zipPath, chip) {
  const entry = `${chip}/sdkconfig`;
  let text;
  try {
    text = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0014-verify: could not read ${entry} from ${zipPath} (is the chip built and packaged?)`, { cause });
  }
  if (!text.trim()) throw new Error(`0014-verify: ${entry} is empty in ${zipPath}`);
  return text;
}

// A keyed basename is "defconfig.<chip>"; map it back to the chip subtree in the zip.
function chipOf(defconfigBasename) {
  const m = /^defconfig\.(.+)$/.exec(defconfigBasename);
  if (!m) throw new Error(`0014-verify: addedDefconfigLines key "${defconfigBasename}" is not a defconfig.<chip> name`);
  return m[1];
}

function main(argv) {
  const zipPath = argv[2];
  if (!zipPath) throw new Error('usage: node scripts/0014-verify.mjs <built-release.zip>');
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const added = lock.addedDefconfigLines ?? {};
  const chips = new Set(lock.enabledChips ?? []);
  // addedDefconfigLines holds chip keys (defconfig.<chip>) and memory-fragment keys (e.g.
  // defconfig.qio_ram, which scripts/0016-verify.mjs owns). This verify is about each chip's resolved
  // config, so it considers only keys that name an enabled chip and leaves the rest to their own verify.
  const keys = Object.keys(added).filter((k) => chips.has(chipOf(k)));
  if (!keys.length) throw new Error('0014-verify: UPSTREAM.lock has no per-chip addedDefconfigLines entry; nothing to prove (did the lock lose its REV_MIN append?)');

  const results = [];
  let failed = false;
  for (const basename of keys) {
    const chip = chipOf(basename);
    const sdkconfig = extractSdkconfig(zipPath, chip);
    const lines = sdkconfig.split('\n');
    const missing = added[basename].filter((line) => !lines.includes(line));
    // esp32 is the chip this ADR targets: the appended REV_MIN=3 must have dropped the cache workaround.
    const workaroundPresent = chip === 'esp32' && lines.includes(CACHE_WORKAROUND);
    results.push({ chip, missing, workaroundPresent });
    if (missing.length) {
      failed = true;
      console.error(`FAIL  ${chip}: appended defconfig line(s) absent from resolved sdkconfig: ${missing.join(', ')}`);
    }
    if (workaroundPresent) {
      failed = true;
      console.error(`FAIL  ${chip}: ${CACHE_WORKAROUND} still present (REV_MIN=3 did not take; IRAM libc bloat returns)`);
    }
    if (!missing.length && !workaroundPresent) {
      console.log(`ok    ${chip}: ${added[basename].length} appended line(s) present${chip === 'esp32' ? ', cache workaround absent' : ''}`);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ zip: zipPath, added, results }, null, 2)}\n`);
  if (failed) {
    console.error(`rev-min verification failed; see ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`rev-min verified across ${keys.length} chip(s); findings in ${OUT_PATH}`);
}

main(process.argv);
