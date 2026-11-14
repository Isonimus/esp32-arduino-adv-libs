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
