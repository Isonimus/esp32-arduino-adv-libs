#!/usr/bin/env node
// Verify (slice-0022, ADR-0021 / repo rule 3). The unattended error-gate half of patch #2: given the
// built release zip, it asserts that the shipped esp32 libs carry CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY
// set on every config surface a consumer compiles EXT_RAM_BSS_ATTR against: the base esp32/sdkconfig
// (Kconfig form, CONFIG_X=y) and each esp32 memory-variant include/sdkconfig.h (C-header form,
// #define CONFIG_X 1). With the flag unset, EXT_RAM_BSS_ATTR expands to nothing and a tagged static
// buffer stays in DRAM .bss, which is what overflowed the classic ESP32 for the consumer
// (esp32-wifi-sapper:ADR-0080). "The consumer links a tagged buffer into PSRAM" is the other half, proven
// by the As-built link trial; this proves the gating config is present and guards against a rebuild
// dropping it (CLAUDE.md section 4 invariant 12).
//
//   node scripts/0022-verify.mjs <built-release.zip>
//
// scripts/0014-verify.mjs already covers the base line generically (every addedDefconfigLines entry in the
// resolved per-chip sdkconfig); this script owns the consumer-facing variant headers 0014 does not read,
// and re-checks the base for defense in depth. It reads enabledChips from UPSTREAM.lock and writes findings
// to .verify-out/ for human review; the pass/fail decision is fully automatic.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0022-spiram-bss.json');

const CHIP = 'esp32';
const SYMBOL = 'CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY';

function listEntries(zipPath) {
  let out;
  try {
    out = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0022-verify: could not list ${zipPath}`, { cause });
  }
  return out.split('\n').filter(Boolean);
}

function extract(zipPath, entry) {
  let text;
  try {
    text = execFileSync('unzip', ['-p', zipPath, entry], { encoding: 'utf8' });
  } catch (cause) {
    throw new Error(`0022-verify: could not read ${entry} from ${zipPath} (is ${CHIP} built and packaged?)`, { cause });
  }
  if (!text.trim()) throw new Error(`0022-verify: ${entry} is empty in ${zipPath}`);
  return text;
}

// Each esp32/<variant>/include/sdkconfig.h in the zip. Discovered rather than hardcoded so a builder that
// adds or renames a memory variant is checked too (and the count can never silently drop to zero).
// Coverage assumes a consumer-selectable variant ships its header at this exact path, which is the stable
// arduino-esp32 precompiled-libs layout; a header packaged elsewhere would escape the check (no present
// trigger, so not guarded here rather than guessed at a second path).
function variantHeaders(zipPath) {
  const re = new RegExp(`^${CHIP}/([^/]+)/include/sdkconfig\\.h$`);
  return listEntries(zipPath)
    .map((e) => ({ entry: e, m: re.exec(e) }))
    .filter(({ m }) => m)
    .map(({ entry, m }) => ({ entry, variant: m[1] }));
}

function main(argv) {
  const zipPath = argv[2];
  if (!zipPath) throw new Error('usage: node scripts/0022-verify.mjs <built-release.zip>');
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const chips = lock.enabledChips ?? [];
  if (!chips.includes(CHIP)) {
    console.log(`ok    ${CHIP} not enabled; nothing to check`);
    return;
  }

  const findings = [];
  let failed = false;

  // Base config is Kconfig-format (CONFIG_X=y / "# CONFIG_X is not set").
  const baseEntry = `${CHIP}/sdkconfig`;
  const baseSet = extract(zipPath, baseEntry).split('\n').includes(`${SYMBOL}=y`);
  findings.push({ entry: baseEntry, set: baseSet });
  if (baseSet) {
    console.log(`ok    ${baseEntry}: ${SYMBOL}=y`);
  } else {
    failed = true;
    console.error(`FAIL  ${baseEntry}: ${SYMBOL} not set (EXT_RAM_BSS_ATTR expands to nothing; static PSRAM .bss unavailable)`);
  }

  // Variant configs are C-header format (#define CONFIG_X 1). An unset symbol is simply absent.
  const headers = variantHeaders(zipPath);
  if (!headers.length) {
    throw new Error(`0022-verify: no ${CHIP}/<variant>/include/sdkconfig.h found in ${zipPath} (is ${CHIP} built and packaged?)`);
  }
  for (const { entry, variant } of headers) {
    const set = extract(zipPath, entry).split('\n').includes(`#define ${SYMBOL} 1`);
    findings.push({ entry, set });
    if (set) {
      console.log(`ok    ${variant}: ${SYMBOL} set`);
    } else {
      failed = true;
      console.error(`FAIL  ${entry}: #define ${SYMBOL} 1 absent (consumer compiles EXT_RAM_BSS_ATTR as a no-op for this variant)`);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ zip: zipPath, chip: CHIP, symbol: SYMBOL, findings }, null, 2)}\n`);
  if (failed) {
    console.error(`spiram-bss verification failed; see ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`spiram-bss verified for ${CHIP} (base + ${headers.length} variant header(s)); findings in ${OUT_PATH}`);
}

main(process.argv);
