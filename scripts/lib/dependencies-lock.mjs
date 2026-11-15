// Pure check behind the slim's post-build gate (slice-0012, ADR-0011). Kept in lib/ (like
// source-pins.mjs) so the verify script that uses it can run its main() unconditionally, with no
// import-time side effect and no entry-point guard to get wrong, while this stays unit-testable.
import { escapeRegExp } from './regex.mjs';

// Given one chip's dependencies.lock text, every removed component must be absent and every kept
// sentinel present. Returns { chip, offenders, missing } with empty arrays on success. The lock is YAML
// with one `<namespace>/<name>:` key per resolved component, so an exact key-token match (name at line
// start or after whitespace, immediately followed by ':') is both specific (no false hit on a hash, a
// version, or a substring of a longer name) and complete (a transitively re-pulled component still
// appears as its own key).
export function checkDependenciesLock(depLockText, chip, { removed, kept }) {
  const has = (component) => new RegExp(`(^|\\s)${escapeRegExp(component)}:`, 'm').test(depLockText);
  const offenders = removed.filter((c) => has(c));
  const missing = kept.filter((c) => !has(c));
  return { chip, offenders, missing };
}

// --- resolved-dependency drift gate (slice-0027, ADR-0026) -------------------
// The reproducibility gate ADR-0001 section 6 always wanted, cut down to what is achievable and
// meaningful: not a byte-for-byte artifact compare (infeasible, the zip name and manifest carry the
// build date; disproportionate, the image apt/pip layers and the IDF/GCC build are not bit-pinned),
// but an assertion that the *resolved dependency tree* did not drift from a committed snapshot. The
// component manager resolves esp-dsp / esp-modbus / the kept arduino deps transitively at build time
// and writes <chip>/dependencies.lock; nothing pinned it, so a rebuild could silently resolve a newer
// transitive component. This projects the provenance-meaningful facts and diffs them.

// Count of leading spaces; the component-manager lock is regular 2-space YAML, so indent is structural.
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Project a component-manager `dependencies.lock` (YAML) down to the provenance-meaningful set: each
 * resolved component's `version` and `component_hash`, the `target`, and the sorted `direct_dependencies`.
 * Everything else is deliberately excluded. Requirement ranges (the nested `dependencies:` version specs)
 * are not the resolved tree; `source` URLs and `manifest_hash` are inputs/fingerprints, not resolution
 * outputs, and `manifest_hash` in particular would make the gate fire on any manifest edit even when
 * resolution is unchanged, training re-blesses on noise. `idf` stays in the map as its own component (it
 * carries a resolved `version` and no hash). Pure. Fails loud on a structurally malformed lock (a
 * component with no resolved version, or a file carrying no `dependencies:` block / no `target:`), so a
 * truncated or wrong-shape lock cannot project to an empty tree that then matches another empty tree.
 *
 * Indentation is the parse key, because it is what separates a component's own resolved `version:` (4
 * spaces, a direct child of the 2-space component key) from a requirement spec's `version:` (6 spaces,
 * under a `- name:` list item in the component's nested `dependencies:`). See the lock's own layout:
 *
 *   dependencies:            # 0 spaces, opens the resolved map
 *     espressif/esp-dsp:     # 2 spaces, a component key
 *       component_hash: ...  # 4 spaces, captured
 *       dependencies:        # 4 spaces, a sub-block, ignored
 *       - name: idf          # 4 spaces, list item, ignored
 *         version: '>=4.2'   # 6 spaces, a REQUIREMENT range, ignored
 *       version: 1.8.2       # 4 spaces, the RESOLVED version, captured
 */
export function projectDependenciesLock(depLockText, { chip } = {}) {
  const where = chip ? `${chip}/dependencies.lock` : 'dependencies.lock';
  const lines = depLockText.split('\n');
  const components = {};
  let target = null;
  let inDeps = false;
  let current = null; // the 2-space component key currently being read

  for (const raw of lines) {
    if (raw.trim() === '') continue;
    const indent = indentOf(raw);
    const line = raw.trim();

    if (indent === 0) {
      // A top-level key (or a `- item` of the column-0 direct_dependencies list) ends the deps block.
      inDeps = line === 'dependencies:';
      current = null;
      const targetMatch = line.match(/^target:\s*(\S+)\s*$/);
      if (targetMatch) target = targetMatch[1];
      continue;
    }

    if (!inDeps) continue;

    if (indent === 2) {
      const keyMatch = line.match(/^(\S[^:]*):$/);
      if (!keyMatch) {
        throw new Error(`projectDependenciesLock: unexpected 2-space line in ${where}: "${raw}"`);
      }
      current = keyMatch[1];
      if (!components[current]) components[current] = { version: null, hash: null };
      continue;
    }

    if (indent === 4 && current) {
      const versionMatch = line.match(/^version:\s*(.+?)\s*$/);
      if (versionMatch) components[current].version = stripYamlScalar(versionMatch[1]);
      const hashMatch = line.match(/^component_hash:\s*(\S+)\s*$/);
      if (hashMatch) components[current].hash = hashMatch[1];
    }
    // indent >= 6 (requirement specs, source, targets items) is deliberately ignored.
  }

  // direct_dependencies is a 0-indent `- item` list, so collect it in a dedicated pass: the main loop's
  // indent===0 branch cannot distinguish a `- item` from another top-level key without this.
  const directDependencies = [];
  let collecting = false;
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    if (indentOf(raw) === 0 && raw.trim() === 'direct_dependencies:') { collecting = true; continue; }
    if (collecting) {
      const item = raw.match(/^- (\S.*?)\s*$/);
      if (item) { directDependencies.push(item[1]); continue; }
      collecting = false; // a non-list 0-indent line closes the list
    }
  }

  if (!target) throw new Error(`projectDependenciesLock: no "target:" in ${where} (not a component-manager lock?)`);
  if (Object.keys(components).length === 0) {
    throw new Error(`projectDependenciesLock: no resolved components in ${where} (empty or malformed "dependencies:" block?)`);
  }
  for (const [name, { version }] of Object.entries(components)) {
    if (version === null) throw new Error(`projectDependenciesLock: component "${name}" has no resolved version in ${where}`);
  }
  return { target, components, directDependencies: [...directDependencies].sort() };
}

// Shed a single pair of surrounding quotes a YAML scalar may carry (the manager quotes some versions,
// e.g. '1.0.22~1'); leaves an unquoted version untouched. Not a general YAML unescaper: these are
// version strings, never multi-line or escaped.
function stripYamlScalar(value) {
  const m = value.match(/^'(.*)'$/) ?? value.match(/^"(.*)"$/);
  return m ? m[1] : value;
}

/**
 * Differences between a committed snapshot projection and a freshly-built one, as human-readable lines.
 * Empty array means the resolved dependency trees match (the gate passes). Each entry names one drift:
 * a changed target, an added or removed component, a changed version or content hash, or a changed
 * direct-dependency set. Pure; order is stable (target, then components sorted by name, then direct deps)
 * so the failure output reads the same across runs.
 */
export function diffDependencyLocks(expected, actual) {
  const diffs = [];
  if (expected.target !== actual.target) {
    diffs.push(`target: expected ${expected.target}, built ${actual.target}`);
  }
  const names = [...new Set([...Object.keys(expected.components), ...Object.keys(actual.components)])].sort();
  for (const name of names) {
    const e = expected.components[name];
    const a = actual.components[name];
    if (e && !a) { diffs.push(`component removed: ${name} (was ${e.version})`); continue; }
    if (!e && a) { diffs.push(`component added: ${name} (now ${a.version})`); continue; }
    if (e.version !== a.version) diffs.push(`version changed: ${name} ${e.version} -> ${a.version}`);
    if (e.hash !== a.hash) diffs.push(`component_hash changed: ${name} (${e.version}) ${shortHash(e.hash)} -> ${shortHash(a.hash)}`);
  }
  const eDirect = expected.directDependencies.join(',');
  const aDirect = actual.directDependencies.join(',');
  if (eDirect !== aDirect) {
    diffs.push(`direct_dependencies changed: [${eDirect}] -> [${aDirect}]`);
  }
  return diffs;
}

function shortHash(hash) {
  if (hash === null) return '(none)';
  return hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;
}
