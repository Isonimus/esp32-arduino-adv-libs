#!/usr/bin/env node
// Verify (slice-0020, ADR-0019 / repo rule 3). The unattended error-gate half of patch #1 (weak-deauth):
// given the built release zip, it asserts that every symbol named in UPSTREAM.lock weakenArchiveSymbols is
// shipped WEAK (nm binding `W`), not strong (`T`), in its archive on every enabled chip.
//
//   ieee80211_raw_frame_sanity_check in libnet80211.a must be weak so the consumer firmwares' strong
//   override in deauth.cpp links without a multiple-definition error and without the fragile per-build
//   objcopy hook they run today (adversary:ADR-0027/0029). net80211 is a vendored binary blob with no
//   source, so the symbol is weakened in-build by objcopy --weaken-symbol (injectWeakenArchiveSymbols);
//   this asserts the result on the real artifact (ADR-0019, the vendored-blob carve-out to invariant 3).
//
//   node scripts/0020-verify.mjs <built-release.zip>
//
// It reads enabledChips and weakenArchiveSymbols from UPSTREAM.lock (single source of truth) and writes
// findings to .verify-out/ for human review; the pass/fail decision is fully automatic. Guards against a
// rebuild re-introducing a strong symbol (CLAUDE.md section 4 invariant 11).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0020-weak-deauth.json');

// nm binding codes: `T` a strong definition in text, `W` a weak definition. We require the shipped
// definition to be weak; a strong one means the weaken step did not run or ran on the wrong archive.
const STRONG = 'T';
const WEAK = 'W';

// Extract one archive member from the zip to a real file (nm needs a seekable archive, and a multi-MB
// .a overruns a piped stdout buffer), then return its nm output. Fails loud if the member is missing or
// empty. unzip -o writes <workDir>/<entry> preserving the path.
function nmArchive(zipPath, entry, workDir) {
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, entry, '-d', workDir], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (cause) {
    throw new Error(`0020-verify: could not extract ${entry} from ${zipPath} (is the chip built and packaged?)`, { cause });
  }
  const dest = join(workDir, entry);
  if (!existsSync(dest) || statSync(dest).size === 0) {
    throw new Error(`0020-verify: ${entry} is missing or empty in ${zipPath}`);
  }
  try {
    // Discard nm's stderr: it prints a harmless "no symbols" note for each archive member that carries
    // none, which is noise, not failure. A real nm failure still throws (non-zero exit).
    return execFileSync('nm', [dest], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (cause) {
    throw new Error(`0020-verify: nm failed on ${entry}`, { cause });
  }
}

// Binding codes nm reports for a symbol's lines. A line is `<addr?> <code> <name>`; we match the exact
// symbol name in the third field so a prefix/suffix symbol cannot be mistaken for it.
function bindingsFor(nmText, symbol) {
  const codes = [];
  for (const line of nmText.split('\n')) {
    const parts = line.trim().split(/\s+/);
    const name = parts[parts.length - 1];
    if (name === symbol && parts.length >= 2) codes.push(parts[parts.length - 2]);
  }
  return codes;
}

function main(argv) {
  const zipPath = argv[2];
  if (!zipPath) throw new Error('usage: node scripts/0020-verify.mjs <built-release.zip>');
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const chips = lock.enabledChips ?? [];
  const weaken = lock.weakenArchiveSymbols ?? {};
  const archives = Object.keys(weaken);
  if (!chips.length) throw new Error('0020-verify: UPSTREAM.lock has no enabledChips; nothing to check');
  if (!archives.length) throw new Error('0020-verify: UPSTREAM.lock has no weakenArchiveSymbols; nothing to prove (did the lock lose its patch #1 entry?)');

  const workDir = mkdtempSync(join(tmpdir(), '0020-verify-'));
  const findings = [];
  let failed = false;
  try {
    for (const chip of chips) {
      for (const archive of archives) {
        const entry = `${chip}/lib/${archive}`;
        const nmText = nmArchive(zipPath, entry, workDir);
        for (const symbol of weaken[archive]) {
          const codes = bindingsFor(nmText, symbol);
          const isWeak = codes.includes(WEAK);
          const isStrong = codes.includes(STRONG);
          // Defined-but-not-weak, or absent entirely, both fail: the override would not link.
          const ok = isWeak && !isStrong;
          findings.push({ chip, archive, symbol, codes, weak: isWeak, strong: isStrong });
          if (ok) {
            console.log(`ok    ${entry}: ${symbol} is weak (W)`);
          } else {
            failed = true;
            if (isStrong) console.error(`FAIL  ${entry}: ${symbol} is strong (T); the weaken step did not run (ADR-0019)`);
            else if (!codes.length) console.error(`FAIL  ${entry}: ${symbol} absent; cannot confirm it shipped weak (upstream renamed it, or wrong archive?)`);
            else console.error(`FAIL  ${entry}: ${symbol} has bindings [${codes.join(',')}], expected a weak (W) definition`);
          }
        }
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ zip: zipPath, weakenArchiveSymbols: weaken, findings }, null, 2)}\n`);
  if (failed) {
    console.error(`weak-deauth verification failed; see ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`weak-deauth verified; findings in ${OUT_PATH}`);
}

main(process.argv);
