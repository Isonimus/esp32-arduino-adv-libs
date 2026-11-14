// Pure lock-reader for the source-pin reachability preflight (slice-0010, ADR-0009). It turns
// UPSTREAM.lock into the ordered list of checks the preflight runs, and is the one place that
// pairs each sourcePins commit with the upstream ref it must be reachable from. The verify script
// (scripts/0010-verify.mjs) and its tests both import this, so the pairing cannot drift between the
// gate and its tests (same arrangement as scripts/lib/provenance.mjs).
//
// No git, no network here: this half is unit-testable, so its guards (a pin with no upstream, an
// upstream naming a missing pin, a malformed SHA) fail loud in a plain node:test. The live ancestry
// check is the network-gated half, and lives in the verify script.

const COMMIT_SHA = /^[0-9a-f]{40}$/;

// The floating sources ADR-0005 pins: ESP-IDF, arduino-esp32, tinyusb. All three must be pinned, or
// the build clones a floating branch head for the unpinned one, which is the exact drift ADR-0005
// exists to remove. This is the one definition of "which pins are mandatory", imported by both the
// preflight (so a reduced lock cannot pass vacuously green) and the build's cmdChip (so a reduced
// lock cannot float silently); the two cannot disagree. Future additions (esp32-camera, esp-sr;
// LEDGER) extend sourcePins with new keys but do not change this mandatory baseline.
export const REQUIRED_SOURCE_PINS = ['idfCommit', 'arduinoCommit', 'tinyusbCommit'];

// Fail loud if any mandatory source pin is absent. A missing pin is not a smaller valid lock: it is
// a floating input (ADR-0005), so it must stop the build, not shrink the set of things checked.
export function assertRequiredSourcePins(sourcePins) {
  if (!sourcePins || typeof sourcePins !== 'object') {
    throw new Error('UPSTREAM.lock: sourcePins is missing or not an object');
  }
  const missing = REQUIRED_SOURCE_PINS.filter((key) => !sourcePins[key]);
  if (missing.length) {
    throw new Error(`UPSTREAM.lock: sourcePins is missing required pin(s) ${missing.join(', ')}; every floating source must be pinned (ADR-0005)`);
  }
}

// Build the reachability check list from a parsed UPSTREAM.lock. Returns one { key, url, ref, sha }
// per sourcePins entry, in sourcePins key order. Throws on any mismatch rather than skipping it:
// a pin the preflight silently does not check is worse than no preflight, because it reads as green
// (ADR-0009: every sourcePins commit must be declared where it is checked).
export function sourcePinChecks(lock) {
  const pins = lock?.sourcePins;
  const upstreams = lock?.sourcePinUpstreams;
  if (!pins || typeof pins !== 'object') {
    throw new Error('UPSTREAM.lock: sourcePins is missing or not an object');
  }
  if (!upstreams || typeof upstreams !== 'object') {
    throw new Error('UPSTREAM.lock: sourcePinUpstreams is missing or not an object');
  }
  // A reduced lock (empty or missing a floating source) must fail here, not silently check fewer
  // pins and report green: that green would certify a build that floats the dropped source.
  assertRequiredSourcePins(pins);

  const pinKeys = Object.keys(pins);
  // An upstream entry for a key that has no pin is a stale declaration pointing at nothing: fail,
  // so the two maps cannot silently diverge.
  for (const key of Object.keys(upstreams)) {
    if (!pinKeys.includes(key)) {
      throw new Error(`UPSTREAM.lock: sourcePinUpstreams names "${key}", which is not in sourcePins`);
    }
  }

  return pinKeys.map((key) => {
    const sha = pins[key];
    if (typeof sha !== 'string' || !COMMIT_SHA.test(sha)) {
      throw new Error(`UPSTREAM.lock: sourcePins.${key} is not a 40-hex commit: ${JSON.stringify(sha)}`);
    }
    const upstream = upstreams[key];
    if (!upstream || typeof upstream !== 'object') {
      throw new Error(`UPSTREAM.lock: sourcePins.${key} has no sourcePinUpstreams entry (where should it be checked?)`);
    }
    const { url, ref } = upstream;
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(`UPSTREAM.lock: sourcePinUpstreams.${key}.url is missing or empty`);
    }
    if (typeof ref !== 'string' || ref.length === 0) {
      throw new Error(`UPSTREAM.lock: sourcePinUpstreams.${key}.ref is missing or empty`);
    }
    return { key, url, ref, sha };
  });
}
