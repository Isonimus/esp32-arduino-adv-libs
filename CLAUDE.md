# esp32-arduino-adv-libs: Project Conventions

This repo owns a patched ESP-IDF + Arduino-core precompiled libraries build. It ships
release artifacts shaped like `framework-arduinoespressif32-libs` so two sibling
authorized-pentest firmwares (`adversary` and `esp32-wifi-sapper`) can retire the
third-party precompiled blob they both pull today with a one-line `platformio.ini` URL
swap. It fixes an ordered patch stack (one concern per patch, each citing its consuming
ADR) on top of a pinned upstream builder, and publishes reproducible, provenance-pinned
releases. See `README.md` for how to consume a release and the `adr/` corpus for why each
patch exists.

Stack: ESP-IDF 5.5 + Arduino-core, built through a fork of
`espressif/esp32-arduino-lib-builder` (a Docker toolchain) driven in GitHub Actions; the
patch stack is numbered `git format-patch` diffs under `patches/`; the stele method's
doc linter is zero-dependency Node.js.

General working practices — quality bar, testing standard, commit hygiene, delegation,
correction, language — live in [`docs/quality-bar.md`](docs/quality-bar.md) and apply here
without being restated. It ships with the method and is vendored into this repo, so it is
yours to adapt; an update keeps what you changed (stele:ADR-0024).

This file carries only what is specific to **this** repo. Restating a rule from the bar here
would create a second copy with no sync path, which is the failure stele:ADR-0005 exists to
prevent.

## 1. Document taxonomy — four kinds

Every document is exactly one of four things.

| Kind | Files | Rule |
|---|---|---|
| **Immutable** | `adr/*.md`, `slices/*.md` | Written once. Body prose is never edited. Only status/supersession fields may change. |
| **Generated** | `adr/INDEX.md` | Built by script from frontmatter. Never hand-edited. |
| **Ledger** | `LEDGER.md` | Exactly one per repo. The only hand-maintained tracker. |
| **Live doc** | `README.md`, `docs/*.md` | Describes how something behaves *now*. Updated **in the same change** as the thing it describes, and cited from this file so it is never orphaned (stele:ADR-0010). |

- **ADR** — a decision later work must obey (a mechanism, data format, or boundary).
  Asserts *"on date X we chose Y because Z"*: a historical claim, true forever.
- **Slice** — one feature work-unit. Written before implementation, **frozen at merge**
  and rewritten to past tense: *"this is what shipped."* Freezing converts it from a
  current-state claim (always going stale) into a historical one (never stale).
- **README.md** — live document; update it in the same change that alters any
  user/dev-facing feature or API.

**Single writer, one direction.** An ADR records a deferral *once*, as a fact about that
decision. `LEDGER.md` cites the ADR. **Never reach back into an ADR to close a ledger
item.** Closing an item means deleting its line from the ledger.

Changing our minds means writing a **new** ADR that supersedes the old one, never editing
it. The superseding note must say *why the old reasoning was wrong* — that record is the
most valuable thing this workflow produces, and an in-place edit destroys it.

A committed document's body may **gain** lines — an appended `## Amendment — <date>: …`, or a
correction marker placed at the claim it corrects — and may never lose or rewrite one. The
hook enforces this (stele:ADR-0019); frontmatter is exempt, because status and supersession
fields are how a record announces it was superseded.

This is also how a justified rule-violation gets recorded. `~/.claude/CLAUDE.md` §2 says a
justified violation is written down as a decision rather than taken as a silent exception;
in this repo, that decision is a new or superseding ADR.

## 2. Enforcement — invariants are executable

`node scripts/lint-docs.mjs` runs from a pre-commit hook and in CI. The hook checks the
**commit**, not the working tree, so a fix you forgot to stage cannot green a red commit
(stele:ADR-0018); alongside the linter it verifies that `adr/INDEX.md` matches the corpus and
that immutable bodies have only gained lines (stele:ADR-0019).

A citation is bare (`ADR-NNNN`) only when it means *this* repo, and qualified
(`<repo>:ADR-NNNN`) otherwise (stele:ADR-0009). The linter resolves citations in `LEDGER.md`,
in the corpus, and in the prose that is read as instruction — this file, `README.md`,
`docs/`, `.claude/commands/` — so a citation that rots there fails the build rather than
quietly misrouting the next session (stele:ADR-0020).

A rule enforced by memory is a rule that holds until the first busy afternoon. If a
convention matters, it gets a rule; if it genuinely can't be checked, say so out loud
rather than writing it down and trusting it.

Run `/wrap-up` before finishing a task.

## 3. Verification harness — measure, don't assume

Some changes cannot be asserted in a unit test: rendering, world generation, physics,
timing, anything whose correctness is "does it look and behave right at runtime". The
answer is **not** to skip verification and eyeball it once by hand.

**Any slice whose behaviour a unit test cannot assert ships a verification script.**

`scripts/<slice>-verify.mjs` — drives the real system headlessly, exercises the specific
behaviour the slice claims, and:

- **fails on any console error or page error** — this half is pass/fail and machine-checkable;
- **writes artifacts** (screenshots, dumps, measured numbers) for human review — this half
  needs eyes, and that is fine, as long as the first half still runs unattended;
- **is named in the slice's `## Verification` section**, so the claim and its evidence are
  linked;
- **is wired into `package.json`**, and its error-check half runs in CI.

That last point is the one that gets skipped, so it is **rule-checked** (R11): the linter
fails if any `scripts/*-verify.mjs` is absent from `package.json`. A verify script that is
not wired runs exactly once, on the day it was written, and is dead thereafter — it
documents that the slice worked once, which is not what a regression check is for. Probes
are exempt: a probe answers its question once and the number lands in an ADR.

Every slice carries two required sections, both rule-checked: `## Verification` names the
proof (R12), and `## Definition of Done` states the acceptance criteria as Given/When/Then
scenarios written before the code (R13, stele:ADR-0011). Each scenario names its proof in
`## Verification`; the linter checks the sections exist and that the Definition of Done
holds a full triad — it cannot check that a scenario is *right*, which is what `/wrap-up`
is for.

Probes are the same tool used before the fact: when a design question has a measurable
answer (how many caves per chunk, what the frame cost is), write `scripts/<topic>-probe.mjs`
and put the **measured numbers** in the ADR. Design decisions cite data, not estimates.

## 4. Standing invariants

Repo-specific definition-of-done rules. A slice is not complete until it satisfies every
one that applies. Each cites the ADR that created it; exceptions are listed with the
reason, so nobody "fixes" a deliberate choice.

These live **here, in the repo** — not in assistant memory. A rule that governs the
codebase must be greppable, diffable, reviewable, and survive a change of machine
(stele:ADR-0005).

Each row declares how it is **enforced**, so an aspiration is never mistaken for a
guarantee:

- `verified_by: <script>` — a wired verify script or lint rule checks it;
- `pending (LEDGER)` — enforceable but not yet enforced; a ledger item carries the debt;
- `review-only` — enforceable only by human judgement, so `/wrap-up` is the enforcement.

The declaration is a convention checked at review, not by the linter — the linter does not
read this file (stele:ADR-0004). What it *does* enforce is that every `verified_by` script is
actually wired (R11), so a row cannot claim a check that runs nowhere.

| # | Invariant | Source | Enforced by |
|---|---|---|---|
| 1 | One concern per patch. Combining two concerns into one patch is forbidden (it refuses to answer "which change broke the link"). | ADR-0001 | review-only |
| 2 | Each patch header cites its consuming ADR (`adversary:ADR-NNNN` or `esp32-wifi-sapper:ADR-NNNN`) with a short rationale. | ADR-0001 | review-only |
| 3 | No post-build binary rewrite ships in a release; a correction is a source patch, never an objcopy-style post-hook. | ADR-0001 | review-only |
| 4 | Every tagged release builds and publishes all enabled chips (`esp32`, `esp32s3`); a per-chip build failure fails the whole release. | ADR-0001 | verified_by: `scripts/build.mjs` package mode (fails if any enabled chip tar is missing, `release.yml` `package` needs the `chips` matrix) |
| 5 | Every release is reconstructable from the five recorded pins (upstream builder commit, resolved IDF commit, resolved Arduino-core commit, patch-stack content hash, Docker image digest) plus the patch stack; the manifest records all five. | ADR-0001 | verified_by: `scripts/0002-verify.mjs` (asserts the manifest carries all five pins; wired in `package.json`, R11) |
| 6 | Every `sourcePins` commit is ancestor-reachable from its declared `sourcePinUpstreams` ref (tested by ref-ancestry, never fetch-by-SHA); the `pins` preflight gates the `chips` matrix so an unreachable pin fails before the build. | ADR-0009 | verified_by: `scripts/0010-verify.mjs` (live ref-ancestry check per pin; wired as `verify:pins` in `package.json`, R11, and as the `release.yml` `pins` job the `chips` matrix needs) |
| 7 | No component removed as unused (`removedComponents` + `removedArduinoComponents`) appears in any enabled chip's resolved `dependencies.lock`, and the kept sentinel components still do; a removal that silently re-pulls, or a future change that re-introduces a removed component, fails the build. | ADR-0011 | verified_by: `scripts/0012-verify.mjs` (inspects each chip's `dependencies.lock` in the built zip; wired as `verify:slim` in `package.json`, R11, and run in the `release.yml` `package` job) |
| 8 | The released `esp32` libs build for `CONFIG_ESP32_REV_MIN=3`: the resolved `esp32/sdkconfig` carries `CONFIG_ESP32_REV_MIN_3=y` and no `CONFIG_SPIRAM_CACHE_WORKAROUND=y`. Below rev 3 the PSRAM cache workaround relocates libc into IRAM and overflows the esp32 drop-in (measured 7272 B, ADR-0013); a change that drops the append or re-lowers the min revision fails the build. | ADR-0013 | verified_by: `scripts/0014-verify.mjs` (inspects the built zip's `esp32/sdkconfig`; wired as `verify:revmin` in `package.json`, R11, and run in the `release.yml` `package` job) |

When an ADR's consequences create a rule that all *future* work must follow, add the row
in the same commit as the ADR.
