---
id: '0010'
title: "CI preflight: prove every source pin is reachable before the build"
type: slice
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Goal

Close the LEDGER `[audit]` item (ADR-0005): no automated gate proves each `sourcePins` commit is
reachable from a clonable ref on its upstream, so an unreachable pin fails only at build time with
`reference is not a tree`, after a ~2h both-chip build has started (it cost run `43494803612`).
Ship a cheap CI preflight that checks reachability by ref-ancestry (ADR-0009), gating the `chips`
matrix so an unreachable pin fails in seconds. Measured cost: 1-4s and tens of MB per pin, three
pins in well under a minute, against the build they guard.

## Definition of Done

- **Given** `UPSTREAM.lock` whose three `sourcePins` commits are all ancestor-reachable from their
  declared `sourcePinUpstreams` refs
- **When** the preflight runs
- **Then** it reports each pin REACHABLE and exits 0

- **Given** a `sourcePins` commit that is a real commit object but reachable from no ref on its
  upstream (the historical arduino pin `32709d56` on `espressif/arduino-esp32` `master`)
- **When** the preflight checks it
- **Then** it resolves UNREACHABLE and the preflight exits non-zero, naming the pin, before any
  build step

- **Given** `UPSTREAM.lock` with a `sourcePins` key that has no matching `sourcePinUpstreams` entry,
  or a pin whose value is not a 40-hex commit
- **When** the preflight builds its check list
- **Then** it fails loud naming the offending key, rather than skipping it

- **Given** `release.yml` on a push that touches the overlay
- **When** the workflow runs
- **Then** the `pins` preflight job runs and the `chips` matrix depends on it, so an unreachable pin
  fails the run without spending the build

## Design

Reachability is tested by ref-ancestry, not fetch-by-SHA (ADR-0009): `git fetch --filter=tree:0
--no-tags <url> <ref>` then `git merge-base --is-ancestor <sha> FETCH_HEAD`. The measured numbers
and the reason the obvious fetch-by-SHA test is wrong (GitHub serves retained objects by explicit
want, so it passes the unreachable `32709d56`) are in ADR-0009.

Split by testability (repo rule 3):

- **Pure, unit-tested** (`scripts/lib/source-pins.mjs`, `sourcePinChecks(lock)`): read the lock into
  an ordered list of `{ key, url, ref, sha }`, one per `sourcePins` entry. Fail loud if a pin has no
  matching `sourcePinUpstreams` entry (a pin added without declaring where to check it), if an
  upstream entry names a pin that does not exist, or if a SHA is not 40-hex. No network, no git, so
  it is a plain `node:test`.
- **Network-gated** (`scripts/0010-verify.mjs`): for each check, run the fetch into a throwaway temp
  repo and decide ancestry; report REACHABLE / UNREACHABLE per pin and exit non-zero on any
  UNREACHABLE. It also runs one negative self-check against the historical `32709d56`, which must
  resolve UNREACHABLE: that reproduces the real regression and fails loud if git/GitHub ever made
  ancestry-testing unreliable. This is the slice's verification script and the production preflight:
  the proof and the gate are the same artifact.

Lock schema: add `sourcePinUpstreams` (and its `...Comment`) as a sibling of `sourcePins`, keyed by
the same keys (`idfCommit`, `arduinoCommit`, `tinyusbCommit`), each `{ url, ref }`. Sibling, not a
reshape of `sourcePins`, so the existing readers (`pinBuildSources` in `scripts/build.mjs`) are
untouched.

**Existing code considered.** Searched `scripts/` and `scripts/lib/` for any reachability or
`git`-remote helper: none exists (the build force-checks-out pins but never pre-validates them, which
is the gap). `scripts/0002-verify.mjs` is the pattern for a wired, error-gating verify script and is
mirrored for exit-code and output-dir conventions; its logic (zip-shape inspection) is unrelated and
is not reused. The pure/impure split mirrors `scripts/lib/provenance.mjs` (one definition imported by
producer and consumer), here one lock-reader imported by the verify script and its tests.

## Verification

- **Unit** (`test/source-pins.test.mjs`, run by `npm test`): `sourcePinChecks` returns one check per
  pin with the right `url`/`ref`/`sha`; fails loud on a pin with no upstream, on an upstream naming a
  missing pin, and on a non-40-hex SHA. These fail before the `source-pins.mjs` guards exist and pass
  after. Covers DoD scenario 3.
- **Network-gated preflight** (`scripts/0010-verify.mjs`, wired as `verify:pins` in `package.json`,
  R11): run live, it asserts the three real pins REACHABLE (DoD scenario 1) and the historical
  `32709d56` UNREACHABLE (DoD scenario 2), exiting non-zero on any surprise. Its error-gate half runs
  in CI as the `pins` job.
- **CI wiring** (`release.yml`): the `pins` job runs `verify:pins` and the `chips` matrix lists it in
  `needs`, so an unreachable pin fails the run before the build (DoD scenario 4). Verified by reading
  the workflow and by the next overlay-touching push exercising it.

## As built

Shipped as designed. `scripts/lib/source-pins.mjs` exposes `sourcePinChecks(lock)`, the pure
lock-reader; `scripts/0010-verify.mjs` is the network-gated preflight and the production gate in
one; `test/source-pins.test.mjs` covers the pure guards. `UPSTREAM.lock` gained
`sourcePinUpstreams` (plus its comment). Wired as `verify:pins` in `package.json` and as the
`release.yml` `pins` job the `chips` matrix now `needs`. CLAUDE.md section 4 gained invariant 6,
citing ADR-0009; the LEDGER `[audit]` line was deleted.

Each Definition-of-Done scenario was met:

- **Scenario 1** (reachable pins pass): `npm run verify:pins` run live 2026-11-14 reported all three
  pins REACHABLE and exited 0.
- **Scenario 2** (unreachable pin fails loud): the negative self-check against the historical
  `32709d56` resolved UNREACHABLE in the same run, proving the gate catches the exact commit that
  broke run `43494803612`; an UNREACHABLE verdict sets exit 1 before any build step.
- **Scenario 3** (under-declared / malformed lock fails loud): `test/source-pins.test.mjs` asserts a
  pin with no upstream, an upstream naming a missing pin, and a non-40-hex SHA each throw; 46/46
  tests pass.
- **Scenario 4** (CI gating): `release.yml` now carries the `pins` job and `chips` lists it in
  `needs`; confirmed by reading the workflow. The next overlay-touching push exercises it live.

One measured correction drove the design and is recorded in ADR-0009: the obvious `git fetch <url>
<sha>` reachability test passes for the unreachable `32709d56` (GitHub serves the retained object by
explicit want), so the gate uses ref-ancestry instead. Measured cost: 1-4s and 3-15MB per pin.

The adversarial pass (one Sonnet reviewer, blind to intent) found no path for an unreachable pin to
pass as reachable, and surfaced one real gap: a reduced lock (empty `sourcePins`, or only
`idfCommit`) passed the preflight vacuously green, and `build.mjs` then skipped pin injection and
cloned floating `master` heads for the dropped sources, the exact ADR-0005 drift. Fixed at the root
with a shared `REQUIRED_SOURCE_PINS` contract in `scripts/lib/source-pins.mjs`: both the preflight
(`sourcePinChecks`) and the build (`cmdChip`) now call `assertRequiredSourcePins`, so a lock missing
any floating source fails loud in CI and in a direct local build, not silently. Two reviewer notes
were declined with reason: the preflight exits non-zero on a lock-validation error (fail-loud is met;
a stack trace is loud and diagnosable, so wrapping it adds code without changing the safe outcome),
and point-in-time reachability (a force-push after the check) is inherent to any pre-build gate.
