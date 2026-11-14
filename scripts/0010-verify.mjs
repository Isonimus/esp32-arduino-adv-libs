#!/usr/bin/env node
// Source-pin reachability preflight (slice-0010, ADR-0009). The network-gated error-gate half of
// the slice's proof, and the production preflight itself: the gate and its proof are one artifact.
// For every sourcePins commit in UPSTREAM.lock it proves the commit is ancestor-reachable from the
// branch the builder clones, so the builder's `git clone` + `git checkout <pin>` will find it. An
// unreachable pin fails here in seconds instead of at `git checkout` after a ~2h build has started
// (it cost run 43494803612; ADR-0005 Amendment, ADR-0009).
//
//   node scripts/0010-verify.mjs
//
// Reachability is tested by REF-ANCESTRY, never by `git fetch <url> <sha>`. Measured 2026-11-14,
// fetch-by-sha returns rc=0 for the unreachable arduino commit 32709d56, because GitHub serves a
// retained object by explicit SHA even when no ref reaches it; a `git clone` of a ref does not pull
// it, so the builder's checkout fails. The faithful test mirrors clone+checkout: fetch the ref's
// commit graph (tree:0, no blobs) and ask whether the pin is an ancestor of it. If you are tempted
// to "simplify" this to `git fetch <url> <sha>`, read ADR-0009 first: that is the exact blind spot
// this gate exists to close.
//
// It exits non-zero on any pin that is UNREACHABLE, on a lock that fails validation, or if the
// negative self-check (the historical 32709d56, which MUST come back UNREACHABLE) does not. It
// writes the per-pin verdict table to .verify-out/0010-pins.json for human review (rule 3).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcePinChecks } from './lib/source-pins.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(REPO_ROOT, 'UPSTREAM.lock');
const OUT_PATH = join(REPO_ROOT, '.verify-out', '0010-pins.json');

// The real regression from ADR-0005's Amendment: bmorcelli/arduino-esp32 master 32709d56, reachable
// from no espressif ref. It is a genuine commit object the server still serves by SHA, so it is the
// exact case a fetch-by-sha test waves through. The preflight must call it UNREACHABLE; if it ever
// does not, ref-ancestry has stopped distinguishing reachable from unreachable (a git/GitHub change,
// or a bug here), and every verdict below is suspect, so we fail loud rather than trust them.
const NEGATIVE_SELF_CHECK = {
  key: 'self-check:historical-unreachable-arduino',
  url: 'https://github.com/espressif/arduino-esp32.git',
  ref: 'master',
  sha: '32709d56deb6030b2aa16a456a8c7c1c9e20a7e9',
};

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

// True iff <sha> is reachable (an ancestor of, or equal to) <ref> on <url>, mirroring what a clone
// of <ref> plus a checkout of <sha> would find. A fetch failure (network, or a vanished ref) is a
// hard error, not an "unreachable" verdict: we must not report a pin unreachable because the network
// blinked. Only a successful fetch whose graph does not contain the commit is UNREACHABLE.
function isReachable(url, ref, sha) {
  const work = mkdtempSync(join(tmpdir(), 'pin-reach-'));
  try {
    git(work, ['init', '-q']);
    try {
      git(work, ['fetch', '--filter=tree:0', '--no-tags', url, ref]);
    } catch (cause) {
      throw new Error(`fetch failed for ${url} ref ${ref}: ${cause.stderr?.toString().trim() || cause.message}`);
    }
    // Present in the fetched (single-ref, tree:0) graph <=> reachable from that ref. cat-file -e
    // returns 0 present / 1 absent; anything else is a real error we let through.
    let present;
    try {
      git(work, ['cat-file', '-e', `${sha}^{commit}`]);
      present = true;
    } catch (cause) {
      if (cause.status === 1) present = false;
      else throw cause;
    }
    if (!present) return false;
    // Rigor: confirm ancestry of the fetched ref head, not mere presence. 0 = ancestor, 1 = not.
    try {
      git(work, ['merge-base', '--is-ancestor', sha, 'FETCH_HEAD']);
      return true;
    } catch (cause) {
      if (cause.status === 1) return false;
      throw cause;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  const checks = sourcePinChecks(lock); // throws loud on a malformed or under-declared lock

  const results = [];
  let failed = false;

  // Negative self-check first: if ref-ancestry can no longer flag a known-unreachable commit, the
  // real verdicts below mean nothing, so bail before trusting them.
  const selfReachable = isReachable(NEGATIVE_SELF_CHECK.url, NEGATIVE_SELF_CHECK.ref, NEGATIVE_SELF_CHECK.sha);
  results.push({ ...NEGATIVE_SELF_CHECK, verdict: selfReachable ? 'REACHABLE' : 'UNREACHABLE', expected: 'UNREACHABLE' });
  if (selfReachable) {
    failed = true;
    console.error(`FAIL  self-check  ${NEGATIVE_SELF_CHECK.sha}  came back REACHABLE from ${NEGATIVE_SELF_CHECK.url}#${NEGATIVE_SELF_CHECK.ref}`);
    console.error('      ref-ancestry is no longer distinguishing reachable from unreachable (see ADR-0009); every verdict below is suspect.');
  } else {
    console.log(`ok    self-check  historical 32709d56 is UNREACHABLE, as it must be`);
  }

  for (const { key, url, ref, sha } of checks) {
    const reachable = isReachable(url, ref, sha);
    results.push({ key, url, ref, sha, verdict: reachable ? 'REACHABLE' : 'UNREACHABLE', expected: 'REACHABLE' });
    if (reachable) {
      console.log(`ok    ${key}  ${sha}  reachable from ${url}#${ref}`);
    } else {
      failed = true;
      console.error(`FAIL  ${key}  ${sha}  UNREACHABLE from ${url}#${ref}: a clone of ${ref} would not contain it, so build.sh's checkout fails (ADR-0005/ADR-0009).`);
    }
  }

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2)}\n`);

  if (failed) {
    console.error(`\nsource-pin preflight FAILED; verdicts in ${OUT_PATH}`);
    process.exit(1);
  }
  console.log(`\nsource-pin preflight passed: ${checks.length} pin(s) reachable; verdicts in ${OUT_PATH}`);
}

main();
