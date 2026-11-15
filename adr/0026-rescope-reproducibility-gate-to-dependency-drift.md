---
id: '0026'
title: "Re-scope the ADR-0001 section 6 reproducibility gate: withdraw byte-for-byte, adopt a resolved-dependency drift gate, defer full toolchain bit-determinism"
type: architecture
status: accepted
date: 2026-11-15
supersedes: []
superseded_by: []
---

## Context

ADR-0001 section 6 fixed the CI gate contract before the pipeline existed, and its third bullet read:
"Reproducibility: a tag rebuild compares byte-for-byte against the prior build of the same tag;
divergence fails the release." Contact with the built v0.0.2 pipeline shows that contract is both
**infeasible as worded** and **disproportionate**. Three obstacles, each read from the shipped code, not
estimated:

1. **The published artifact cannot be byte-identical by construction.** `scripts/build.mjs` `cmdPackage`
   bakes the build date into the zip *name* (`adv-esp32-arduino-libs-<IDF_TAG>-<YYYYMMDD>-<SHORTSHA>.zip`)
   and writes `builtOn: new Date().toISOString()` into `manifest.json`. Two rebuilds on different days
   differ in the wrapper bytes before any toolchain question is reached, so a raw-zip byte compare is
   defeated at the name and the manifest, independent of whether the library payload is identical.

2. **The builder image is not reconstructable, only attested.** `cmdImage` pins the Dockerfile `FROM`
   base by digest, but the upstream Dockerfile's `apt`/`pip` layers are unpinned. Manifest pin #5 records
   the resulting image **ID** as an attestation of *what ran*, not a reconstruction input: a rebuild weeks
   later pulls whatever apt/pip packages are current and produces a different gcc/binutils, so the objects
   can differ legitimately. The LEDGER already states this.

3. **IDF/GCC library builds are not deterministic without dedicated work.** `__DATE__`/`__TIME__` macros,
   absolute `__FILE__` build paths baked into objects and assertions, non-deterministic `ar` member
   mtime/uid/gid, and link order all vary run to run. Byte-identical `.a` files would need
   `SOURCE_DATE_EPOCH`, deterministic `ar`, `-ffile-prefix-map`, and a frozen image: a sizeable,
   upstream-coupled effort with ongoing maintenance, for a two-consumer internal appliance.

So ADR-0001 section 6's "byte-for-byte" clause is a contract that did not survive contact with the
artifact. This is corrected the way ADR-0019/0023/0024/0025 corrected the section 7 roadmap bullets: by a
new ADR that records *why* the prior wording was wrong, never by editing immutable ADR-0001.

Separately, the LEDGER has long carried the tractable, valuable piece as a `[bug]`: the component manager
resolves the transitive tree (esp-dsp, esp-modbus, the kept arduino deps, and on esp32s3 the esp-sr stack
before it was removed) at build time and writes `<chip>/dependencies.lock` into the artifact, but nothing
pins or captures it, so a rebuild could silently resolve a newer transitive component. That lock is the
one reproducibility surface that is both meaningful (it is the resolved provenance of the RF stack) and
achievable today.

## Decision

**Re-scope the ADR-0001 section 6 reproducibility clause.** The release's reproducibility guarantee is
redefined as three parts, replacing the single byte-for-byte compare:

1. **Five-pin provenance (already shipped).** The manifest records the upstream builder commit, resolved
   IDF commit, resolved Arduino-core commit, patch-stack content hash, and builder image digest (standing
   invariant 5, `scripts/0002-verify.mjs`). This is the as-built provenance record ADR-0001 section 5
   always required and does not change here.

2. **A resolved-dependency drift gate (new, standing invariant 13, slice-0027).** Each enabled chip's
   resolved `dependencies.lock` is captured as a committed snapshot under `reference/`, and the build
   fails if a rebuild's resolved tree drifts from it. The gate compares the provenance-meaningful
   projection (each resolved component's `version` and `component_hash`, the `target`, and the sorted
   `direct_dependencies`), not the raw bytes: that pins the facts a provenance appliance cares about (what
   version of what component, with what content) while staying robust to cosmetic YAML-emitter churn that
   would otherwise train re-blesses on noise. `manifest_hash` and requirement ranges are deliberately
   excluded as inputs/fingerprints rather than resolution outputs. A genuine, intended drift (a bumped
   pin, a removed component) is re-blessed by re-capturing the snapshot from the new green build, so the
   drift is a reviewed change rather than a silent one.

3. **Full toolchain bit-determinism is explicitly deferred,** not abandoned. Making the artifact payload
   byte-reproducible (pinning the image apt/pip layers, `SOURCE_DATE_EPOCH` + deterministic `ar` +
   `-ffile-prefix-map`, normalizing the zip, and standing up a prior-build store to diff against) is a
   large, upstream-coupled effort disproportionate to a two-consumer internal appliance today. The debt
   sits on the LEDGER with this reason, so "withdrawn" is not mistaken for "never" and nobody re-attempts
   the byte-for-byte gate without first reading why it was re-scoped.

**The literal "byte-for-byte artifact compare" gate of ADR-0001 section 6 is withdrawn.** Obstacle 1
alone makes it unsatisfiable (the gate would fire on every build purely from the date in the name and
manifest, independent of the payload), and obstacles 2 and 3 make a corrected "payload byte-for-byte"
variant disproportionate. ADR-0001 is not superseded: its fork model, tracking policy, release shape, and
the rest of its section 6 CI contract (build all chips on overlay push, publish on tag) stand. This ADR
corrects one bullet of section 6 with measured evidence, exactly as ADR-0019/0023/0024/0025 corrected
section 7 bullets.

## Consequences

- **Standing invariant 13 is created** (added to `CLAUDE.md` section 4 in this same change):
  every tagged release's resolved `<chip>/dependencies.lock` matches the committed `reference/` snapshot
  for every enabled chip, `verified_by: scripts/0027-verify.mjs`. slice-0027 builds the gate.
- **The LEDGER `[bug]` (capture dependencies.lock) is closed by slice-0027,** and the `[deferred]`
  byte-for-byte line is re-scoped to the toolchain-bit-determinism deferral, citing this ADR, so the
  three obstacles above are not re-discovered later.
- **The gate is a drift detector, not a resolution pin.** It catches and surfaces drift; it does not feed
  the committed lock back into the component manager to *prevent* re-resolution. Feeding it back is
  possible but couples to the manager's manifest-hash gating (our overlay rewrites the manifest, so a
  fed-back lock would be honored only when its `manifest_hash` matched the post-overlay manifest exactly,
  or silently ignored). For a provenance appliance, a *visible* drift that a human re-blesses is the
  safer default than a silent pin that could hold a stale, vulnerable transitive component; the pin
  variant is recorded as a possible future strengthening, not built.
- **The snapshot is captured from a real build, never hand-authored.** It is the component manager's own
  output, committed verbatim. The v0.0.2 artifact's lock cannot seed it: v0.0.2 predates the esp-sr
  removal (ADR-0017), so its esp32s3 tree still carries esp-sr and its transitive stack (esp-dl, dl_fft,
  cjson, esp_new_jpeg), which `main` no longer resolves. The snapshot is therefore captured from the
  first green build on the current lock (slice-0027 `## As built`), which is the only honest source.
- **No change to the published-release flow or the five-pin manifest.** This adds a gate and a committed
  snapshot; it does not alter what a release ships or how a consumer swaps its `platformio.ini` URL.
- ADR-0001 is not superseded; its section 6 CI contract stands except for the one re-scoped bullet.
