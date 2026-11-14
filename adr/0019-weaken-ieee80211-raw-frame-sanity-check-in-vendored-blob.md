---
id: '0019'
title: "Ship libnet80211.a weak via an in-build vendored-blob objcopy, and narrow the no-binary-rewrite invariant"
type: architecture
status: accepted
date: 2026-11-14
supersedes: []
superseded_by: []
---

## Context

Patch #1 on the roadmap (ADR-0001 section 7, release `v0.1.0`) is
`weak-ieee80211_raw_frame_sanity_check`: bake the weak-deauth symbol into the shipped libs so the two
consumer firmwares retire the fragile `objcopy` hook they both run today (driven by `adversary:ADR-0027`
and `adversary:ADR-0029`; `esp32-wifi-sapper` runs the same hook). Each consumer provides its own strong
definition of `ieee80211_raw_frame_sanity_check` in `deauth.cpp` to permit raw management-frame TX. For
that override to link, the matching symbol inside the precompiled `libnet80211.a` must be **weak**. The
consumers achieve that with a PlatformIO pre-build hook (`scripts/weaken_deauth_pre.py` +
`scripts/weaken_deauth_symbol.sh`) that runs `objcopy --weaken-symbol=ieee80211_raw_frame_sanity_check`
on the installed archive before every build. A `framework-arduinoespressif32-libs` reinstall silently
restores strong linkage and breaks the link with a multiple-definition error, so the hook must re-run on
every clean build: exactly the fragility this repo exists to retire (ADR-0001 payoff 2).

ADR-0001 described patch #1 as *"declare the symbol `__attribute__((weak))` in the IDF source."* Measured
on 2026-11-14, that premise is false and the measurement disproves it:

- **net80211 is closed-source.** The 802.11 MAC is shipped by Espressif as a prebuilt binary
  (`esp-wifi-lib` submodule); the lib-builder copies `libnet80211.a` into the output verbatim and never
  compiles it. There is no `.c` to patch.
- **The symbol is already a strong definition inside the vendored archive.** In our shipped `v0.0.2`
  artifact, `nm esp32/lib/libnet80211.a` and `nm esp32s3/lib/libnet80211.a` both report
  `0000005c T ieee80211_raw_frame_sanity_check`. `__attribute__((weak))` on a source *declaration* only
  affects *references*, never a definition already baked into a `.a`; the T-vs-W binding lives in that
  archive's own symbol table, set at Espressif's compile time.
- **The only lever to ship the archive weak is `objcopy --weaken-symbol` on the blob itself**, which is
  what the consumer hook already does. The difference patch #1 makes is *where and when*: once, inside
  our build, so the released archive is weak-by-construction and the consumer fetches it already weak.

That mechanism sits in tension with standing invariant 3 (ADR-0001 section 4): *"No post-build binary
rewrite ships in a release; a correction is a source patch, never an objcopy-style post-hook."* Invariant
3's **intent** is to kill the fragile post-fetch hook; its **letter** bans all `objcopy`. The two are
separable, and this case separates them. After the evidence above and the three options (bake it in with
a recorded carve-out; abandon patch #1 and keep the consumer hooks; or push a consumer-side linker
`--wrap`) were put to the operator on 2026-11-14, the operator chose to bake it in and record the
narrowing as a decision rather than take a silent exception.

## Decision

### 1. Mechanism: weaken the symbol in-build, on the vendored archive

During our build, after `idf.py ... idf-libs` produces each enabled chip's
`esp32-arduino-libs/<chip>/lib/libnet80211.a`, run the IDF xtensa `objcopy --weaken-symbol=` on it for
each configured symbol. The shipped archive is therefore weak-by-construction. This is delivered as an
**overlay** `build.sh` rewrite, not a `patches/NNNN-*.patch`: there is no source diff to format-patch,
because there is no source. It mirrors the esp-sr overlay (ADR-0017) and the component-slim overlay
(ADR-0006, ADR-0011): a pure, exported `build.mjs` helper rewrites the cloned `build.sh` host-side and
fails loud if its anchor is gone.

The set of archives and symbols is config-driven from `UPSTREAM.lock` `weakenArchiveSymbols` (a map of
archive basename to the list of symbols to weaken), applied to every chip in `enabledChips`. The injected
`build.sh` block **fails loud** when the archive is missing or the named symbol is absent from it: a bare
`objcopy --weaken-symbol` silently no-ops when the symbol has been renamed or removed upstream, which
would ship a strong symbol and break the consumer link, so the step refuses rather than no-op. The
authoritative check that the *shipped* archive is weak is a wired verify script on the built zip (below),
so the build asserts the precondition and the artifact proves the result.

### 2. Narrow standing invariant 3 to the fragile form it exists to kill

Invariant 3 bans a binary rewrite applied **downstream of the release** or used to **hide a
source-fixable defect**: a consumer or post-fetch hook over the published archive (silently reverted by a
reinstall), or a rewrite of our own *compiled-from-source* output that a patch should fix at the source.
What this ADR sanctions is different in kind: a symbol-table weakening of a **vendored binary blob** (an
archive the build copies verbatim and cannot compile from source), performed **once inside our build**,
declared in `UPSTREAM.lock`, and asserted by `nm` on the shipped artifact in a wired verify script. That
is the robust, weak-by-construction form invariant 3 exists to *produce*, not the fragile form it exists
to forbid. When a symbol lives only in a vendored binary, "source patch" is not an available form;
refusing the only available form would forfeit founding payoff 2 for no safety gain, since this edit is
source-controlled (via the lock and the overlay), reproducible, and verified.

### 3. Scope guard

The carve-out is for vendored-binary blobs only. Anything the build compiles from source stays under
invariant 3's source-patch rule: a defect with a source form is fixed in source, never by `objcopy`. A
sanctioned weakening must name its archive and symbols in `weakenArchiveSymbols` and be asserted on the
shipped artifact by a wired verify script; an unverified rewrite, or one over a source-available target,
remains banned.

## Consequences

- **Standing invariant created** (added to `CLAUDE.md` section 4 as row 11 in this same commit): the
  shipped `libnet80211.a` carries `ieee80211_raw_frame_sanity_check` as a **weak** symbol on every
  enabled chip; `verified_by: scripts/0020-verify.mjs` (runs `nm` on the built zip's per-chip archive).
  Invariant 3's row is amended in the same commit to cite this ADR's vendored-binary carve-out, so the
  narrowing is visible where the rule is read.
- **The consumers can retire their hook** on the release that carries this: `adversary` and
  `esp32-wifi-sapper` drop `scripts/weaken_deauth_pre.py` + `scripts/weaken_deauth_symbol.sh` (their
  `ADR-0027` / `ADR-0029` supersession). Until a consumer repins, its hook is an idempotent no-op on an
  already-weak archive (the script short-circuits when the symbol is already `W`), so there is no flag
  day.
- **`patches/` stays empty.** Patch #1 is an overlay step plus a lock entry, not a numbered source patch.
  The roadmap's "patch #1" label is kept for continuity; the deliverable is the overlay and the
  `weakenArchiveSymbols` entry, verified on the artifact.
- The weakening is symbol-table-only: it changes no code and no other symbol, so a consumer that does not
  override `ieee80211_raw_frame_sanity_check` links and runs exactly as before.
- ADR-0001 is not superseded: its fork model, release shape, and the rest of its invariants stand
  unchanged. This ADR refines one consequence (invariant 3) with a fact ADR-0001 did not have.
