#!/usr/bin/env node
// Verify (slice-0018, ADR-0017 / repo rule 3). The unattended error-gate half of the esp-sr removal:
// given the built release zip, it asserts two measurable consequences on the real artifact.
//
//   1. The deliberately-removed per-chip subtree(s) (UPSTREAM.lock removedChipSubtrees, e.g.
//      esp32s3/esp_sr/) are absent. That directory, holding srmodels.bin and partitions.csv, is
//      produced ONLY by the esp32s3 srmodels_bin step in build.sh (stripEspSrModelStep), so its absence
//      proves the step was removed and no speech model blob shipped.
//   2. The esp32s3 resolved sdkconfig no longer bakes CONFIG_ESPTOOLPY_FLASHSIZE_16MB and falls back to
//      the common CONFIG_ESPTOOLPY_FLASHSIZE_4MB default. That 16MB came only from defconfig.esp_sr,
//      which build.sh composes only while esp_sr is in the esp32s3 features list (removeBuildFeatures),
//      so the 4MB fallback proves the feature was dropped from the esp32s3 build (ADR-0017).
//
// esp-sr's absence from each chip's resolved dependencies.lock is proven separately by
// scripts/0012-verify.mjs (esp-sr is in removedComponents), and the shipped artifact's shape parity by
// scripts/0002-verify.mjs (which subtracts removedChipSubtrees). "Both chips still build green" is the
// CI matrix. This guards against a rebuild re-introducing esp-sr (CLAUDE.md section 4 invariant 10).
//
//   node scripts/0018-verify.mjs <built-release.zip>
//
// It reads enabledChips and removedChipSubtrees from UPSTREAM.lock (single source of truth) and writes
// findings to .verify-out/ for human review; the pass/fail decision is fully automatic.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0018-esp-sr.json');

// The esp32s3 flash-size consequence of dropping the esp_sr feature (ADR-0017): defconfig.esp_sr set
// 16MB (overriding defconfig.common's 4MB); with the feature gone, the common 4MB default stands.
const FLASH_CHIP = 'esp32s3';
const FLASH_16_SYMBOL = 'CONFIG_ESPTOOLPY_FLASHSIZE_16MB';
const FLASH_GONE = `${FLASH_16_SYMBOL}=y`; // base sdkconfig is Kconfig-format
const FLASH_EXPECTED = 'CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y';

function listZipEntries(zipPath) {
  let text;
  try {
    text = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0018-verify: could not list entries of ${zipPath}`, { cause });
  }
  const entries = text.split('\n').filter(Boolean);
  if (!entries.length) throw new Error(`0018-verify: ${zipPath} has no entries`);
  return entries;
}

function extract(zipPath, entry) {
  let text;
  try {
    text = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0018-verify: could not read ${entry} from ${zipPath} (is the chip built and packaged?)`, { cause });
  }
  if (!text.trim()) throw new Error(`0018-verify: ${entry} is empty in ${zipPath}`);
  return text;
}

function main(argv) {
  const zipPath = argv[2];
  if (!zipPath) throw new Error('usage: node scripts/0018-verify.mjs <built-release.zip>');
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const chips = new Set(lock.enabledChips ?? []);
  const removedChipSubtrees = lock.removedChipSubtrees ?? {};
  // Consider only enabled chips: a removal keyed to a chip we do not ship is not our artifact to check.
  const keys = Object.keys(removedChipSubtrees).filter((chip) => chips.has(chip));
  if (!keys.length) throw new Error('0018-verify: UPSTREAM.lock has no removedChipSubtrees for an enabled chip; nothing to prove (did the lock lose its esp-sr removal?)');

  const entries = listZipEntries(zipPath);
  const findings = [];
  let failed = false;

  for (const chip of keys) {
    // Sanity: the chip subtree must exist, so an empty or mis-shaped zip cannot pass vacuously.
    const chipPresent = entries.some((e) => e.startsWith(`${chip}/`));
    if (!chipPresent) {
      failed = true;
      console.error(`FAIL  ${chip}/: subtree absent from the zip (nothing to check against; broken artifact?)`);
    }
    for (const sub of removedChipSubtrees[chip]) {
      const prefix = `${chip}/${sub}`; // sub already carries its trailing slash, e.g. "esp_sr/"
      const offenders = entries.filter((e) => e.startsWith(prefix));
      findings.push({ chip, subtree: sub, present: offenders.length > 0, offenders });
      if (offenders.length) {
        failed = true;
        console.error(`FAIL  ${prefix}: still present in the artifact (${offenders.length} entr(y/ies); srmodels step not removed)`);
      } else {
        console.log(`ok    ${prefix} absent`);
      }
    }
  }

  // The esp32s3 flash-size fallback (only meaningful if esp32s3 is enabled).
  if (chips.has(FLASH_CHIP)) {
    const sdkconfig = extract(zipPath, `${FLASH_CHIP}/sdkconfig`).split('\n');
    const has16 = sdkconfig.includes(FLASH_GONE);
    const has4 = sdkconfig.includes(FLASH_EXPECTED);
    findings.push({ chip: FLASH_CHIP, flash16Present: has16, flash4Present: has4 });
    if (has16) {
      failed = true;
      console.error(`FAIL  ${FLASH_CHIP}/sdkconfig: ${FLASH_GONE} still set (esp_sr feature not dropped; defconfig.esp_sr still composed)`);
    }
    if (!has4) {
      failed = true;
      console.error(`FAIL  ${FLASH_CHIP}/sdkconfig: ${FLASH_EXPECTED} absent (expected the common 4MB default after dropping esp_sr)`);
    }
    if (!has16 && has4) console.log(`ok    ${FLASH_CHIP}/sdkconfig: flash size fell back to 4MB (esp_sr feature dropped)`);

    // The esp_sr feature fed every esp32s3 phase, so the mem variants composed defconfig.esp_sr too. No
    // variant sdkconfig.h may re-add the 16MB define (C-header format: `#define CONFIG_X 1`). Derived
    // from the zip so every shipped variant is covered without a hardcoded list (ADR-0017).
    const variantHeader = new RegExp(`^${FLASH_CHIP}/[^/]+/include/sdkconfig\\.h$`);
    for (const entry of entries.filter((e) => variantHeader.test(e))) {
      const variant16 = extract(zipPath, entry).split('\n').includes(`#define ${FLASH_16_SYMBOL} 1`);
      findings.push({ entry, flash16Present: variant16 });
      if (variant16) {
        failed = true;
        console.error(`FAIL  ${entry}: #define ${FLASH_16_SYMBOL} 1 (variant re-adds esp_sr 16MB flash)`);
      } else {
        console.log(`ok    ${entry}: no 16MB flash define`);
      }
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ zip: zipPath, removedChipSubtrees, findings }, null, 2)}\n`);
  if (failed) {
    console.error(`esp-sr removal verification failed; see ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`esp-sr removal verified; findings in ${OUT_PATH}`);
}

main(process.argv);
