---
id: '0009'
title: "Test source-pin reachability by ref-ancestry, not fetch-by-SHA"
type: architecture
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Context

ADR-0005's Amendment (2026-11-13) established an unstated requirement the hard way: run
`43494803612` (commit `c4d9cdd`) spent time getting into a build and then failed the arduino
checkout with `fatal: reference is not a tree: 32709d56...`, because that pin, a `bmorcelli`
fork commit, is reachable from no `espressif/arduino-esp32` ref. A plain `git clone` downloads
the objects reachable from branches and tags, not every loose object the server retains, so the
builder's `git clone` + `git checkout <sha>` cannot find it. The amendment corrected the pin and
wrote the rule: each `sourcePins` commit must be an exact commit **reachable from a clonable ref**
on its upstream. It left the automated gate as a LEDGER item: without one, an unreachable pin is
caught only at build time, after a ~2h both-chip build has already started.

The obvious implementation of that gate is wrong, and wrong in a way the next reader will
re-introduce. Measured 2026-11-14 against the exact historical cases:

| Command | Target | Result |
|---|---|---|
| `git fetch --depth=1 <url> <sha>` | idf `8410210c9a` (reachable ancestor of `release/v5.5`) | rc=0 |
| `git fetch --depth=1 <url> <sha>` | arduino `32709d56` (**unreachable** fork commit, the real failure) | **rc=0** |
| `git fetch --depth=1 <url> <sha>` | arduino `9b3364c6` (reachable base) | rc=0 |

Fetch-by-SHA passes for the unreachable commit. GitHub serves a retained object by explicit
`want` even when it is reachable from no advertised ref, so "can the server return this SHA" is
not the question the builder's clone asks. The builder asks "is this SHA in what a clone of a ref
contains," i.e. **is it an ancestor of the ref being cloned**. A reachability gate must mirror
clone+checkout, not the server's object-want policy, or it passes exactly the pin that breaks the
build.

The faithful test, measured 2026-11-14 on the same cases plus tinyusb:

| Pin | Upstream ref | Verdict | fetch | `.git` |
|---|---|---|---|---|
| idf `8410210c9a` | `espressif/esp-idf` `release/v5.5` | REACHABLE | 4s | 15M |
| arduino `32709d56` | `espressif/arduino-esp32` `master` | **UNREACHABLE** | 1s | 10M |
| arduino `9b3364c6` | `espressif/arduino-esp32` `master` | REACHABLE | 1s | 3M |
| tinyusb `91214b46` | `hathach/tinyusb` `master` | REACHABLE | 1s | 6M |

`git fetch --filter=tree:0 --no-tags <url> <ref>` downloads the ref's full commit graph with no
trees or blobs (the `tree:0` partial-clone filter), then `git merge-base --is-ancestor <sha>
FETCH_HEAD` decides ancestry; an unreachable commit is absent from that graph, so `--is-ancestor`
returns non-zero. Three pins cost well under a minute and tens of MB, against the ~2h build they
guard.

## Decision

The CI preflight tests each `sourcePins` commit for reachability by **ref-ancestry**, not by
fetch-by-SHA:

```
git fetch --filter=tree:0 --no-tags <url> <ref>     # ref's commit graph, no trees/blobs
git merge-base --is-ancestor <sha> FETCH_HEAD        # 0 = reachable, non-zero = unreachable
```

- **The `<ref>` is the branch the builder actually clones for that source**, not "any ref." The
  builder clones one branch per source (idf `release/v5.5` via `build.sh -I`; arduino `master` via
  `install-arduino.sh`; tinyusb `master` via `update-components.sh`), then force-checks-out our pin
  (ADR-0005). Testing ancestry of that one branch is exactly the clone the builder performs, and is
  cheaper than enumerating every ref. This is intentionally stricter than the amendment's looser
  "a clonable ref" phrasing where the two differ: a commit reachable from some *other* ref but not
  the cloned branch would still break the builder, so the cloned branch is the honest target.

- **Fetch-by-SHA (`git fetch <url> <sha>`) is forbidden as the reachability test**, because it is
  measured to pass for the unreachable `32709d56`. This is the non-obvious part the gate exists to
  defend, so it is stated here and cited at the code site: a later "simplification" to fetch-by-SHA
  silently restores the blind spot.

- **Each pin's `(url, ref)` is declared in `UPSTREAM.lock` under `sourcePinUpstreams`**, keyed by
  the same key as the pin in `sourcePins`. The lock is this repo's single source of truth for pins
  (ADR-0001 section 1); the upstream to check against is part of a pin's definition, so it belongs
  in the lock, not hardcoded in the check. The check fails loud if a `sourcePins` key has no
  matching `sourcePinUpstreams` entry, so a pin cannot be added without declaring where it is
  checked.

This is a consequence of ADR-0005's amendment, not a change to it: ADR-0005's decision (pin every
floating input to an exact, reachable commit; the `build.sh` injection mechanism) stands unchanged.
This ADR only fixes *how* the reachability half of that decision is proven automatically.

## Consequences

- A new standing invariant (CLAUDE.md section 4, invariant 6): every `sourcePins` commit is
  ancestor-reachable from its declared `sourcePinUpstreams` ref, and the preflight gates the
  `chips` matrix so an unreachable pin fails in seconds, before the build. `verified_by`
  `scripts/0010-verify.mjs`.
- The preflight is network-dependent, so it is a wired check script, not a unit test (repo rule 3).
  The pure part (reading the lock into a list of `(key, url, ref, sha)` checks, failing loud on a
  pin with no upstream or a malformed SHA) is unit-tested; the live `git` ancestry call is the
  network-gated half whose error-gate runs in CI.
- The preflight carries a negative self-check against the historical `32709d56` on
  `espressif/arduino-esp32` `master`: it must resolve UNREACHABLE. That reproduces the real
  regression and, as a bonus, fails loud if a future git or GitHub change ever made ancestry-testing
  unreliable, which would invalidate the whole approach, rather than letting it rot silently.
- Adding `esp32-camera` or `esp-sr` pins later (LEDGER) means adding their `sourcePins` and
  `sourcePinUpstreams` entries together; the preflight then covers them with no code change.
