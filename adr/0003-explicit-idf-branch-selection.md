---
id: '0003'
title: "The IDF version is selected explicitly, not inferred from the pinned builder"
type: architecture
status: superseded
date: 2026-11-13
supersedes: []
superseded_by: ['0005']
---

## Context

ADR-0001 section 1 anchored the fork at `espressif/esp32-arduino-lib-builder` tag
`idf-release_v5.5`, commit `e68e30112ffad75e96535408dfe25bff6d2f26fb`, and stated that the
resolved IDF commit "that the pinned builder produces" is captured in the manifest, measured
at build time. That framing assumed the pinned builder tree determines the IDF version. The
first heavy CI run proved it does not.

The first release build to reach the runners (run `43471209349`, 2026-11-13) failed compiling
the `esp-tflite-micro` managed component. The compiler command line recorded the version
actually being built: `-DIDF_VER="v5.3.6-389-g9b5a12f3d43"`. The consumers' blob, and this
repo's entire premise, is ESP-IDF 5.5.

Root cause, measured in the builder tree at the pinned commit: `tools/config.sh` defaults
`IDF_BRANCH="release/v5.3"` when no branch is given, and `build.sh` only sets `IDF_BRANCH`
from its `-I` option. This repo's `scripts/build.mjs` invoked `./build.sh -e -t <chip>` with
no `-I`, so every build silently took the builder's default (5.3), not the 5.5 the pin name
advertises. The downstream `esp-tflite-micro` compile error was a symptom of building the
wrong, stale tree, not the disease.

So the builder commit offers a *choice* of IDF version (5.3 by default, 5.5 opt-in via `-I`),
not a single determined one. ADR-0001 section 1's "the pinned builder produces" is therefore
incomplete: the version must be selected, and that selection has to be pinned somewhere the
build reads.

Measured on 2026-11-13: `espressif/esp-idf` branch `release/v5.5` head is
`843e8919c0042506a8501f672ea1f74461180908`; tags `v5.5` and `v5.5.1` exist on that line. The
branch head floats as 5.5 patch releases land.

## Decision

Select the IDF branch explicitly. `UPSTREAM.lock` carries `upstream.idfBranch`
(`release/v5.5`), and `scripts/build.mjs` passes it to `build.sh` as `-I <idfBranch>`. The
build fails loud if `idfBranch` is absent, rather than fall back to the builder's 5.3 default
(`chipBuildCommand` throws; `cmdChip` asserts the field before cloning).

This **refines** ADR-0001 section 1; it does not supersede it. ADR-0001's deliberate choice
stands: the resolved IDF and Arduino commits are not pinned in the lock, they are measured
into each release manifest at build time. What was wrong was only the premise that the builder
commit alone fixes the version. We pin the *branch selection* (a stable intent, `release/v5.5`)
in the lock; the *resolved commit* that branch points at remains measured, not pinned. Pinning
the exact IDF commit (`build.sh -i <sha>`) was the stronger-provenance alternative and was
rejected here to keep ADR-0001's measure-don't-pin model intact; revisiting that is a future
superseding ADR, not this one.

## Consequences

- One concern this ADR does **not** close: `esp-tflite-micro` and the other managed components
  are still pulled unpinned by the IDF component manager at build time, so a registry update
  can break or change a build that the five pins claim is reconstructable. Building the correct
  5.5 tree may resolve the specific C++-standard compile error (5.5's component constraints and
  toolchain differ from 5.3's), but the reproducibility gap is real and independent. It is
  tracked in `LEDGER.md` against this ADR, not fixed here.
- `UPSTREAM.lock` gains a field (`upstream.idfBranch`) that the build now requires. A lock
  without it is a hard error, by design: a silent default is exactly what caused this.
- The Arduino-core branch is left at the builder's own default. Unlike `IDF_BRANCH`, it was not
  observed to resolve to a mismatched line in the failing run; if a later build shows the same
  class of drift for Arduino-core, it gets the same explicit-selection treatment and an
  amendment here.
