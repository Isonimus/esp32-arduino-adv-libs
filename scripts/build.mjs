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
// The in-container bash command for a chip build. The IDF is pinned two ways: -I selects the
// branch to clone (the builder's tools/config.sh defaults IDF_BRANCH to release/v5.3, so without
// -I it silently builds the wrong IDF), and -i checks out an exact commit on that branch so the
// build is reproducible rather than tracking a floating branch head (ADR-0005, superseding
// ADR-0003). safe.directory comes first: the clone is owned by the runner user but the container
// runs as root, so without it git rejects /workspace as "dubious ownership" and every rev-parse
// the lib-builder runs for version detection fails (which then breaks patch application, source
// checkout, and CMake source resolution); '*' also covers IDF's nested submodule worktrees. -e
// archives the per-chip result to dist/.
export function chipBuildCommand(chip, idfBranch, idfCommit) {
  if (!chip) throw new Error('chipBuildCommand: chip is required');
  if (!idfBranch) throw new Error('chipBuildCommand: idfBranch is required');
  if (!idfCommit) throw new Error('chipBuildCommand: idfCommit is required');
  return `git config --global --add safe.directory '*' && ./build.sh -e -I ${idfBranch} -i ${idfCommit} -t ${chip}`;
}

/**
 * Pin the floating source repos the builder clones at build time to exact commits. build.sh clones
 * arduino-esp32 (install-arduino.sh) and tinyusb (update-components.sh) at a floating branch head,
 * which drift and break: today tinyusb master dropped a file the pinned CMake still lists, and
 * arduino master needs an esp_matter header its resolved version lacks. We insert force-checkouts
 * right after those clones run, so the full clones are moved to the reproducibility snapshot before
 * the build configures (ADR-0005). IDF is pinned separately via build.sh -i, so it is not repeated
 * here. Pure: rewrites and returns the build.sh text; fails loud if the anchor or a pin is missing,
 * so an upstream script change cannot silently skip pinning.
 */
export function pinBuildSources(buildShText, { arduinoCommit, tinyusbCommit }) {
  if (!arduinoCommit) throw new Error('pinBuildSources: arduinoCommit is required');
  if (!tinyusbCommit) throw new Error('pinBuildSources: tinyusbCommit is required');
  const anchor = '    # install arduino component\n    ./tools/install-arduino.sh\n    if [ $? -ne 0 ]; then exit 1; fi\n';
  if (!buildShText.includes(anchor)) {
    throw new Error('pinBuildSources: install-arduino anchor not found in build.sh (upstream layout changed)');
  }
  const injected = anchor +
    '\n    # [adv-libs overlay] pin floating sources to the reproducibility snapshot (ADR-0005)\n' +
    `    git -C components/arduino_tinyusb/tinyusb checkout ${tinyusbCommit}\n` +
    '    if [ $? -ne 0 ]; then exit 1; fi\n' +
    `    git -C components/arduino checkout ${arduinoCommit}\n` +
    '    if [ $? -ne 0 ]; then exit 1; fi\n';
  return buildShText.replace(anchor, injected);
}

function cmdChip(args) {
  requireArgs(args, 'work', 'image', 'chip', 'dist');
  const { upstream, enabledChips, managedComponentPins, sourcePins, removedComponents, builderCxxStandard } = lock();
  if (!enabledChips.includes(args.chip)) {
    throw new Error(`chip "${args.chip}" is not in UPSTREAM.lock enabledChips ${JSON.stringify(enabledChips)}`);
  }
  if (!upstream.idfBranch) {
    throw new Error('UPSTREAM.lock upstream.idfBranch is required (the builder defaults to release/v5.3; see ADR-0003, ADR-0005)');
  }
  if (!sourcePins?.idfCommit) {
    throw new Error('UPSTREAM.lock sourcePins.idfCommit is required (pin the IDF commit, not the floating branch head; see ADR-0005)');
  }
  if (!builderCxxStandard?.from || !builderCxxStandard?.to) {
    throw new Error('UPSTREAM.lock builderCxxStandard {from,to} is required: the pinned arduino master base needs C++20, but the builder forces gnu++17, so without this overlay the build fails deep in the compile (see ADR-0007)');
  }
  const builderDir = cloneUpstream(args.work, upstream);
  applyOverlay(builderDir, managedComponentPins, sourcePins, removedComponents, builderCxxStandard);

  // Build inside our image; override the entrypoint so we run build.sh directly. The container
  // runs as root, so it writes root-owned files into the mounted clone: fine on an ephemeral CI
  // runner, but a LOCAL re-run's cloneUpstream() rmSync of work/builder can hit EACCES and fail
  // loud. Locally, build in a throwaway --work dir (or sudo-remove it) rather than relying on cleanup.
  run('docker', [
    'run', '--rm',
    // Absolute path required: docker reads a relative source as a named volume, not a bind mount.
    '-v', `${resolve(builderDir)}:/workspace`, '-w', '/workspace',
    '-e', 'IDF_COMPONENT_OVERWRITE_MANAGED_COMPONENTS=1',
    '--entrypoint', 'bash',
    args.image, '-c', chipBuildCommand(args.chip, upstream.idfBranch, sourcePins.idfCommit),
  ]);

  const tars = readdirSync(join(builderDir, 'dist')).filter((f) => f.startsWith(`arduino-esp32-libs-${args.chip}-`) && f.endsWith('.tar.gz'));
  if (tars.length !== 1) {
    throw new Error(`expected exactly one dist tar for ${args.chip}, found ${JSON.stringify(tars)}`);
  }
  mkdirSync(args.dist, { recursive: true });
  copyFileSync(join(builderDir, 'dist', tars[0]), join(args.dist, tars[0]));
  console.log(`exported ${tars[0]} to ${args.dist}`);
}

/**
 * Rewrite the version spec of named managed components in an idf_component.yml. The upstream
 * builder declares its ML/camera/matter dependencies as floating minimums (e.g. esp-tflite-micro
 * ">=1.2.0"), so the component manager resolves "latest" at build time: unreproducible, and the
 * reason a newer esp-tflite-micro broke the build (ADR-0004). Pinning rewrites only the targeted
 * component's `version:` line, leaving its other keys (git, require, rules) untouched. Pure:
 * takes and returns text. Fails loud if a pinned component, or its version line, is absent, so a
 * stale pin cannot silently no-op.
 */
export function pinComponentVersions(manifestText, pins) {
  const lines = manifestText.split('\n');
  for (const [component, version] of Object.entries(pins)) {
    const escaped = component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keyRe = new RegExp(`^(\\s+)${escaped}:\\s*$`);
    let keyIdx = -1;
    let keyIndent = '';
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(keyRe);
      if (m) { keyIdx = i; keyIndent = m[1]; break; }
    }
    if (keyIdx === -1) throw new Error(`pinComponentVersions: component "${component}" not found in manifest`);
    let versionIdx = -1;
    for (let i = keyIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() === '') continue;
      const indent = lines[i].match(/^(\s*)/)[1];
      if (indent.length <= keyIndent.length) break; // left this component's block
      if (/^\s+version:\s*/.test(lines[i])) { versionIdx = i; break; }
    }
    if (versionIdx === -1) throw new Error(`pinComponentVersions: no "version:" line for "${component}"`);
    lines[versionIdx] = lines[versionIdx].replace(/^(\s+version:\s*).*$/, `$1"${version}"`);
  }
  return lines.join('\n');
}

/**
 * Remove named managed components, with their full indented block, from an idf_component.yml.
 * The upstream builder declares a Matter/Thread/Zigbee/ML stack the consumer firmwares never use
 * (ADR-0006); a component left in the manifest is downloaded and built, and the stock espressif
 * builder's config for esp_matter cannot build (its OpenThread console needs a Thread config that
 * is off on esp32/esp32s3). Removing esp_matter from the manifest both stops it building and makes
 * arduino-esp32's Matter library self-disable: its sources are guarded by
 * `#ifdef CONFIG_ESP_MATTER_ENABLE_DATA_MODEL`, a symbol the esp_matter Kconfig defines, so without
 * the component the guard is false and the sources compile to nothing. Pure: takes and returns
 * text. Fails loud if a named component is absent, so a stale removal cannot silently no-op.
 */
export function removeManagedComponents(manifestText, names) {
  const lines = manifestText.split('\n');
  for (const component of names) {
    const escaped = component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keyRe = new RegExp(`^(\\s+)${escaped}:\\s*$`);
    let keyIdx = -1;
    let keyIndent = '';
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(keyRe);
      if (m) { keyIdx = i; keyIndent = m[1]; break; }
    }
    if (keyIdx === -1) throw new Error(`removeManagedComponents: component "${component}" not found in manifest`);
    let end = keyIdx + 1; // first line past this component's block
    for (; end < lines.length; end++) {
      if (lines[end].trim() === '') continue; // blank lines belong to the block until a shallower key
      const indent = lines[end].match(/^(\s*)/)[1];
      if (indent.length <= keyIndent.length) break;
    }
    lines.splice(keyIdx, end - keyIdx);
  }
  return lines.join('\n');
}

/**
 * Rewrite the C++ standard the builder forces on the whole project, in its root CMakeLists.txt.
 * The builder's `idf-release_v5.5` branch (our pin e68e301) carries
 * `idf_build_set_property(CXX_COMPILE_OPTIONS "-std=gnu++17;...")`, which appends `-std=gnu++17`
 * after IDF 5.5's own `-std=gnu++2b`, so the last flag wins and the whole project compiles as
 * C++17. But we pin arduino-esp32 to a master-base commit (ADR-0005) newer than that stale branch
 * expects, and that arduino (and esp-dl) build aggregates with parenthesized constructor calls
 * (`vec.emplace_back(a, b)` on a braceless-aggregate struct), which is legal only from C++20 (P0960):
 * under gnu++17 both fail with "no matching function for call". Espressif's own builder master already
 * bumped this line to `-std=gnu++2a`; we match that. Pure: takes and returns text. Fails loud if the
 * `from` flag is absent, so an upstream change to this line cannot silently no-op the fix (ADR-0007).
 */
export function setBuilderCxxStandard(cmakeText, { from, to }) {
  if (typeof from !== 'string' || !from || typeof to !== 'string' || !to) {
    throw new Error(`setBuilderCxxStandard: both "from" and "to" must be non-empty strings, got from=${JSON.stringify(from)} to=${JSON.stringify(to)} (a malformed builderCxxStandard would otherwise write "-std=undefined"; ADR-0007)`);
  }
  const fromFlag = `-std=${from}`;
  const toFlag = `-std=${to}`;
  if (!cmakeText.includes(fromFlag)) {
    throw new Error(`setBuilderCxxStandard: expected "${fromFlag}" not found in CMakeLists.txt (upstream may have changed the CXX_COMPILE_OPTIONS line; re-check the pin against the builder tree, ADR-0007)`);
  }
  return cmakeText.split(fromFlag).join(toFlag);
}

// Apply our delta onto the cloned tree: ordered patch stack, sdkconfig overlay, builder C++ standard,
// managed-component removals, version pins, then floating-source commit pins. All are optional; the
// loops exist so the empty baseline and the later patched releases share one code path. The C++ standard
// rewrite touches the builder's root CMakeLists.txt; removals and pins (removedComponents,
// managedComponentPins) rewrite main/idf_component.yml; source pins (sourcePins.arduinoCommit/tinyusbCommit)
// inject force-checkouts into build.sh. All are build config applied as overlay rewrites, not numbered
// source patches: those are reserved for consumer-ADR features (ADR-0004, ADR-0005, ADR-0006, ADR-0007).
function applyOverlay(builderDir, managedComponentPins, sourcePins, removedComponents, builderCxxStandard) {
  const stack = patchStack(PATCHES_DIR);
  for (const f of stack.files) {
    run('git', ['-C', builderDir, 'apply', '--verbose', join(PATCHES_DIR, f)]);
  }
  if (existsSync(SDKCONFIG_DIR)) {
    for (const f of readdirSync(SDKCONFIG_DIR)) {
      cpSync(join(SDKCONFIG_DIR, f), join(builderDir, 'configs', f));
    }
  }
  if (builderCxxStandard) {
    const cmakePath = join(builderDir, 'CMakeLists.txt');
    writeFileSync(cmakePath, setBuilderCxxStandard(readFileSync(cmakePath, 'utf8'), builderCxxStandard));
  }
  const manifestPath = join(builderDir, 'main', 'idf_component.yml');
  const removals = removedComponents ?? [];
  if (removals.length) {
    writeFileSync(manifestPath, removeManagedComponents(readFileSync(manifestPath, 'utf8'), removals));
  }
  const pins = managedComponentPins ?? {};
  if (Object.keys(pins).length) {
    writeFileSync(manifestPath, pinComponentVersions(readFileSync(manifestPath, 'utf8'), pins));
  }
  if (sourcePins?.arduinoCommit || sourcePins?.tinyusbCommit) {
    const buildShPath = join(builderDir, 'build.sh');
    writeFileSync(buildShPath, pinBuildSources(readFileSync(buildShPath, 'utf8'), sourcePins));
  }
  const pinSummary = Object.entries(pins).map(([k, v]) => `${k}@${v}`).join(', ') || 'none';
  const removeSummary = removals.join(', ') || 'none';
  const srcSummary = sourcePins
    ? `idf@${sourcePins.idfCommit?.slice(0, 10)} arduino@${sourcePins.arduinoCommit?.slice(0, 10)} tinyusb@${sourcePins.tinyusbCommit?.slice(0, 10)}`
    : 'none';
  const cxxSummary = builderCxxStandard ? `${builderCxxStandard.from} -> ${builderCxxStandard.to}` : 'none';
  console.log(`applied overlay: ${stack.count} patch(es), sdkconfig ${existsSync(SDKCONFIG_DIR) ? 'present' : 'none'}, builder c++ std ${cxxSummary}, removed components ${removeSummary}, component pins ${pinSummary}, source pins ${srcSummary}`);
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
  // The stock builder writes one short commit per line, "<name>: <sha>" (e.g. "esp-idf: 8410210c9a0",
  // measured from e68e301's own versions.txt), not "<name>: <branch> <sha>". Match a hex SHA
  // immediately after the label so a format carrying an unexpected extra token fails loud here
  // (invariant 5) instead of silently recording a branch name as a provenance commit.
  for (const line of text.split('\n')) {
    const m = line.match(/^(esp-idf|arduino):\s+([0-9a-f]{7,40})\b/);
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
