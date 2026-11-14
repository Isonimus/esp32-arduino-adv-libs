#!/usr/bin/env node
// Verify (slice-0016, ADR-0015 / repo rule 3). The unattended error-gate half of the esp32s3 PSRAM
// boot fix: given the built release zip, it asserts that the esp32s3 quad/qspi memory variants do NOT
// enable CONFIG_SPIRAM_BOOT_HW_INIT. With it enabled (the stock default from SPIRAM=y), the boot-time
// hardware PSRAM init aborts on a board with no PSRAM chip, which boot-loops a StampS3 Cardputer
// (ADR-0015). "It boots on the real board" is the other half, proven by the As-built hardware re-trial;
// this proves the config that causes the abort is gone and guards against a rebuild re-introducing it
// (CLAUDE.md section 4 invariant 9).
//
//   node scripts/0016-verify.mjs <built-release.zip>
//
// It reads enabledChips from UPSTREAM.lock and writes findings to .verify-out/ for human review; the
// pass/fail decision is fully automatic.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0016-psram.json');

const CHIP = 'esp32s3';
const SYMBOL = 'CONFIG_SPIRAM_BOOT_HW_INIT';
// The quad/qspi esp32s3 memory variants (ADR-0015): they compose defconfig.qio_ram, so they are the
// ones the SPIRAM_BOOT_HW_INIT=n append targets. The octal (opi) variants use defconfig.opi_ram, which
// tolerates a missing chip via IGNORE_NOTFOUND and is out of scope here.
const QUAD_VARIANTS = ['qio_qspi', 'dio_qspi'];

function extract(zipPath, entry) {
  let text;
  try {
    text = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0016-verify: could not read ${entry} from ${zipPath} (is esp32s3 built and packaged?)`, { cause });
  }
  if (!text.trim()) throw new Error(`0016-verify: ${entry} is empty in ${zipPath}`);
  return text;
}

function main(argv) {
  const zipPath = argv[2];
  if (!zipPath) throw new Error('usage: node scripts/0016-verify.mjs <built-release.zip>');
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const chips = lock.enabledChips ?? [];
  if (!chips.includes(CHIP)) {
    console.log(`ok    ${CHIP} not enabled; nothing to check`);
    return;
  }

  const findings = [];
  let failed = false;

  // Base config is Kconfig-format (`CONFIG_X=y` / `# CONFIG_X is not set`).
  const baseEnabled = extract(zipPath, `${CHIP}/sdkconfig`).split('\n').includes(`${SYMBOL}=y`);
  findings.push({ entry: `${CHIP}/sdkconfig`, enabled: baseEnabled });
  if (baseEnabled) {
    failed = true;
    console.error(`FAIL  ${CHIP}/sdkconfig: ${SYMBOL}=y (boot-time PSRAM hw init still on; PSRAM-less board will abort)`);
  }

  // Variant configs are C-header format (`#define CONFIG_X 1`).
  for (const variant of QUAD_VARIANTS) {
    const entry = `${CHIP}/${variant}/include/sdkconfig.h`;
    const enabled = extract(zipPath, entry).split('\n').includes(`#define ${SYMBOL} 1`);
    findings.push({ entry, enabled });
    if (enabled) {
      failed = true;
      console.error(`FAIL  ${entry}: #define ${SYMBOL} 1 (quad/qspi variant still boot-inits PSRAM)`);
    } else {
      console.log(`ok    ${variant}: ${SYMBOL} not enabled`);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ zip: zipPath, chip: CHIP, symbol: SYMBOL, findings }, null, 2)}\n`);
  if (failed) {
    console.error(`psram boot verification failed; see ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`psram boot verified for ${CHIP} (${QUAD_VARIANTS.length} quad variant(s) + base); findings in ${OUT_PATH}`);
}

main(process.argv);
