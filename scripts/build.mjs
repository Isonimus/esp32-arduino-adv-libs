#!/usr/bin/env node
// Build orchestration for the thin overlay (ADR-0001, slice-0002). Three primitives that
// .github/workflows/release.yml wires into the gate contract; a local full build runs them in
// order (see README). Every step fails loud: a nonzero child exit aborts the stage (global
// quality bar), because a release that half-built is worse than one that did not build.
//
//   node scripts/build.mjs image   --work <dir>
//       Build OUR lean builder image from the pinned Dockerfile (UPSTREAM.lock builderImage),
//       with its FROM base rewritten to the pinned digest. Prints and records the image digest
//       (manifest pin #5), reconstructable from our Dockerfile + pinned base, not a Docker Hub tag.
//
//   node scripts/build.mjs chip    --work <dir> --image <ref> --chip <chip> --dist <dir>
//       Clone upstream at the pinned commit, apply the (ordered) patch stack and sdkconfig overlay,
//       run build.sh -e -t <chip> inside the image, and copy the per-chip tar.gz to --dist.
//
//   node scripts/build.mjs package --dist <dir> --out <dir> --image-digest <sha256:...>
//       Combine the per-chip tars into the Bruce-shaped zip (re-rooted at the esp32-arduino-libs
//       contents) and emit the five-pin manifest + the zip's SHA-256. Pure file work, no Docker,
//       so it is locally testable.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { patchStack } from './lib/provenance.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATCHES_DIR = join(REPO_ROOT, 'patches');
const SDKCONFIG_DIR = join(REPO_ROOT, 'sdkconfig');
const UPSTREAM_CLONE_URL = 'https://github.com/espressif/esp32-arduino-lib-builder.git';

function lock() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'UPSTREAM.lock'), 'utf8'));
}

// Run a command, streaming output, and throw on nonzero exit (fail loud).
function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`expected a --flag, got "${argv[i]}"`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function requireArgs(args, ...keys) {
  for (const k of keys) if (!args[k]) throw new Error(`missing required --${k}`);
}

// --- image: build our lean builder image with the base pinned by digest ---
function cmdImage(args) {
  requireArgs(args, 'work');
  const { upstream, builderImage } = lock();
  const builderDir = cloneUpstream(args.work, upstream);

  const srcDockerfile = join(builderDir, builderImage.dockerfilePath);
  const text = readFileSync(srcDockerfile, 'utf8');
  const pinned = pinDockerfileFrom(
    text, builderImage.baseImage, builderImage.baseDigest, builderImage.dockerfilePath,
  );
  const pinnedDockerfile = join(args.work, 'Dockerfile.pinned');
  writeFileSync(pinnedDockerfile, pinned);

  const tag = `adv-esp32-arduino-lib-builder:${upstream.commit.slice(0, 12)}`;
  run('docker', ['build', '--pull=false', '-f', pinnedDockerfile, '-t', tag, dirname(srcDockerfile)]);
  // RepoDigest is only assigned once pushed; for a locally built image the stable identifier is the
  // image ID (content digest of the config). That is what we record as pin #5.
  const imageId = runCapture('docker', ['image', 'inspect', '--format', '{{.Id}}', tag]);
  const infoFile = join(args.work, 'image.json');
  writeFileSync(infoFile, JSON.stringify({ tag, id: imageId }, null, 2) + '\n');
  console.log(`image ${tag} -> ${imageId}`);
  console.log(`wrote ${infoFile}`);
}

function cloneUpstream(work, upstream) {
  const builderDir = join(work, 'builder');
  if (existsSync(builderDir)) rmSync(builderDir, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  run('git', ['init', '-q', builderDir]);
  run('git', ['-C', builderDir, 'remote', 'add', 'origin', UPSTREAM_CLONE_URL]);
  run('git', ['-C', builderDir, 'fetch', '-q', '--depth', '1', 'origin', upstream.commit]);
  run('git', ['-C', builderDir, 'checkout', '-q', upstream.commit]);
  const head = runCapture('git', ['-C', builderDir, 'rev-parse', 'HEAD']);
  if (head !== upstream.commit) {
    throw new Error(`clone HEAD ${head} != pinned ${upstream.commit}`);
  }
  return builderDir;
}

// --- chip: build one chip inside the image and export its tar ---
function cmdChip(args) {
  requireArgs(args, 'work', 'image', 'chip', 'dist');
  const { upstream, enabledChips } = lock();
  if (!enabledChips.includes(args.chip)) {
    throw new Error(`chip "${args.chip}" is not in UPSTREAM.lock enabledChips ${JSON.stringify(enabledChips)}`);
  }
  const builderDir = cloneUpstream(args.work, upstream);
  applyOverlay(builderDir);

  // Build inside our image; override the entrypoint so we run build.sh directly. -e archives the
  // per-chip result to dist/ (upstream tools/archive-build.sh). The container runs as root, so it
  // writes root-owned files into the mounted clone: fine on an ephemeral CI runner, but a LOCAL
  // re-run's cloneUpstream() rmSync of work/builder can hit EACCES and fail loud. Locally, build in
  // a throwaway --work dir (or sudo-remove it) rather than relying on cleanup.
  run('docker', [
    'run', '--rm',
    // Absolute path required: docker reads a relative source as a named volume, not a bind mount.
    '-v', `${resolve(builderDir)}:/workspace`, '-w', '/workspace',
    '-e', 'IDF_COMPONENT_OVERWRITE_MANAGED_COMPONENTS=1',
    '--entrypoint', 'bash',
    // The clone is owned by the runner user but the container runs as root, so git rejects
    // /workspace as "dubious ownership" and every rev-parse the lib-builder runs for version
    // detection fails (which then breaks patch application and CMake source resolution). Mark
    // the mounted tree trusted before building. '*' covers IDF's nested submodule worktrees too.
    args.image, '-c', `git config --global --add safe.directory '*' && ./build.sh -e -t ${args.chip}`,
  ]);

  const tars = readdirSync(join(builderDir, 'dist')).filter((f) => f.startsWith(`arduino-esp32-libs-${args.chip}-`) && f.endsWith('.tar.gz'));
  if (tars.length !== 1) {
    throw new Error(`expected exactly one dist tar for ${args.chip}, found ${JSON.stringify(tars)}`);
  }
  mkdirSync(args.dist, { recursive: true });
  copyFileSync(join(builderDir, 'dist', tars[0]), join(args.dist, tars[0]));
  console.log(`exported ${tars[0]} to ${args.dist}`);
}

// Apply our delta onto the cloned tree: ordered patch stack, then sdkconfig overlay. Both are empty
// for v0.0.1; the loops exist so the baseline and the later patched releases share one code path.
function applyOverlay(builderDir) {
  const stack = patchStack(PATCHES_DIR);
  for (const f of stack.files) {
    run('git', ['-C', builderDir, 'apply', '--verbose', join(PATCHES_DIR, f)]);
  }
  if (existsSync(SDKCONFIG_DIR)) {
    for (const f of readdirSync(SDKCONFIG_DIR)) {
      cpSync(join(SDKCONFIG_DIR, f), join(builderDir, 'configs', f));
    }
  }
  console.log(`applied overlay: ${stack.count} patch(es), sdkconfig overlay ${existsSync(SDKCONFIG_DIR) ? 'present' : 'none'}`);
}

// --- package: combine per-chip tars into the Bruce-shaped zip + manifest ---
function cmdPackage(args) {
  requireArgs(args, 'dist', 'out', 'image-digest');
  const { upstream, enabledChips } = lock();
  mkdirSync(args.out, { recursive: true });
  // Clear any prior build's dated artifacts so out/ holds only this build (the CI verify step and
  // the README glob both assume a single adv-*.zip in out/).
  for (const f of readdirSync(args.out)) {
    if (/^adv-esp32-arduino-libs-.*\.zip(\.sha256)?$/.test(f)) rmSync(join(args.out, f), { force: true });
  }
  const work = join(args.out, '.combine');
  const extractRoot = join(work, 'out');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(extractRoot, { recursive: true });

  // The re-root: Bruce (and the consumers) expect the per-chip dirs at the zip top, i.e. the
  // CONTENTS of esp32-arduino-libs/, one level deeper than upstream's own combine-artifacts.sh.
  const libsDir = join(extractRoot, 'tools', 'esp32-arduino-libs');
  const versionsPath = join(libsDir, 'versions.txt');

  // Each chip tar carries its own versions.txt at the same path, so a later extract overwrites an
  // earlier one. Capture each chip's copy as it lands, then reconcile: the provenance pins must be
  // one agreed value, not whichever chip extracted last (invariant 5).
  const perChipVersions = {};
  for (const chip of enabledChips) {
    const tars = readdirSync(args.dist).filter((f) => f.startsWith(`arduino-esp32-libs-${chip}-`) && f.endsWith('.tar.gz'));
    if (tars.length !== 1) {
      throw new Error(`Scenario B: enabled chip "${chip}" has ${tars.length} tar(s) in ${args.dist}, expected 1 (no partial release)`);
    }
    run('tar', ['xzf', join(args.dist, tars[0]), '-C', extractRoot]);
    if (!existsSync(versionsPath)) throw new Error(`chip ${chip} tar produced no ${versionsPath}`);
    perChipVersions[chip] = readFileSync(versionsPath, 'utf8');
  }
  if (!existsSync(libsDir)) throw new Error(`expected ${libsDir} after extracting chip tars`);

  const resolved = reconcileVersions(versionsPath, perChipVersions);

  const idfTag = upstream.ref.replace(/^idf-release_/, '');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const shortSha = upstream.commit.slice(0, 7);
  const zipName = `adv-esp32-arduino-libs-${idfTag}-${date}-${shortSha}.zip`;
  // Absolute: the zip runs with cwd = libsDir (the re-root), so a relative out/ would resolve there.
  const zipPath = resolve(join(args.out, zipName));
  rmSync(zipPath, { force: true });
  run('zip', ['-q', '-r', zipPath, '.'], { cwd: libsDir });

  const stack = patchStack(PATCHES_DIR);
  const sha256 = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  const manifest = {
    artifact: { name: zipName, sha256, chips: enabledChips },
    pins: {
      upstreamBuilderCommit: upstream.commit,
      resolvedIdfCommit: resolved.idf,
      resolvedArduinoCommit: resolved.arduino,
      patchStackHash: stack.hash,
      builderImageDigest: args['image-digest'],
    },
    patchStack: { count: stack.count, files: stack.files },
    builtOn: new Date().toISOString(),
  };
  const manifestPath = join(args.out, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);
  rmSync(work, { recursive: true, force: true });

  console.log(`packaged ${zipName}`);
  console.log(`  sha256 ${sha256}`);
  console.log(`  resolved idf ${resolved.idf}, arduino ${resolved.arduino}`);
  console.log(`  manifest ${manifestPath}`);
}

// Reconcile the per-chip versions.txt files into one. The resolved IDF/Arduino commits are the
// provenance pins, so every chip must agree on them (a disagreement means the chips were built
// against different sources, which no single manifest can honestly describe). The union of all
// lines is then written back, the way upstream combine-artifacts.sh accumulates them.
// Rewrite the single `FROM <baseImage>` line to pin the base by digest, returning the pinned text.
// Anchored to a real FROM line (start of line, whole image token) and requires exactly one, so a
// commented-out FROM, a second build stage, or a longer tag like 22.04.1 cannot be mis-pinned
// (slice-0002 adversarial pass, F6). sourceLabel only names the file in the error message.
export function pinDockerfileFrom(text, baseImage, baseDigest, sourceLabel = 'the Dockerfile') {
  const escaped = baseImage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fromLine = new RegExp(`^FROM\\s+${escaped}(?=\\s|$)`, 'gm');
  const matches = text.match(fromLine) ?? [];
  if (matches.length !== 1) {
    throw new Error(`cannot pin base: expected exactly one "FROM ${baseImage}" line in ${sourceLabel}, found ${matches.length}`);
  }
  return text.replace(fromLine, `FROM ${baseImage}@${baseDigest}`);
}

export function reconcileVersions(outPath, perChipVersions) {
  const resolvedByChip = Object.fromEntries(
    Object.entries(perChipVersions).map(([chip, text]) => [chip, parseVersionsText(text, chip)]),
  );
  const chips = Object.keys(resolvedByChip);
  const first = resolvedByChip[chips[0]];
  for (const chip of chips.slice(1)) {
    const r = resolvedByChip[chip];
    if (r.idf !== first.idf || r.arduino !== first.arduino) {
      throw new Error(`chips disagree on resolved sources: ${chips[0]} has idf=${first.idf} arduino=${first.arduino}, ${chip} has idf=${r.idf} arduino=${r.arduino}`);
    }
  }
  const seen = new Set();
  const union = [];
  for (const text of Object.values(perChipVersions)) {
    for (const line of text.split('\n')) {
      if (line !== '' && !seen.has(line)) { seen.add(line); union.push(line); }
    }
  }
  writeFileSync(outPath, union.join('\n') + '\n');
  return first;
}

export function parseVersionsText(text, chip) {
  const out = { idf: '', arduino: '' };
  for (const line of text.split('\n')) {
    const m = line.match(/^(esp-idf|arduino):\s+\S+\s+(\S+)/);
    if (!m) continue;
    if (m[1] === 'esp-idf') out.idf = m[2];
    else out.arduino = m[2];
  }
  if (!out.idf || !out.arduino) {
    throw new Error(`could not resolve idf/arduino commits from ${chip} versions.txt (idf="${out.idf}", arduino="${out.arduino}")`);
  }
  return out;
}

// Run the CLI only when invoked as a script, not when imported for tests (the pure helpers above are
// exported for test/build.test.mjs; importing must not kick off a build).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (mode) {
    case 'image': cmdImage(args); break;
    case 'chip': cmdChip(args); break;
    case 'package': cmdPackage(args); break;
    default:
      console.error('usage: node scripts/build.mjs <image|chip|package> [--flag value ...]');
      process.exit(2);
  }
}
