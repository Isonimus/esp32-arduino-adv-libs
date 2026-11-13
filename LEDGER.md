# Ledger

The single mutable file in this repo (stele:ADR-0001). Everything else is
immutable or generated. Open work, deferrals, and known defects all live here — there is
no second tracking file, because two files require manual sync and manual sync does not
happen.

**Closing an item means deleting its line here.** Do not annotate the source ADR; the
ADR's claim ("at the time of this decision we deferred X") stays true forever and needs
no update. Single writer, one direction.

Format: `- [type] description (ADR-NNNN)` — type is `bug` | `feature` | `deferred` |
`audit`. Cite the source ADR where one exists; rule 8 checks that the citation resolves.
A decision that lives in **another** repo is cited `<repo>:ADR-NNNN` — the linter cannot
open that corpus, so it skips qualified references (stele:ADR-0009).

## Open

<!-- One line per open item. Delete the line to close it; the git log is the done-record. -->

- [deferred] CI build/release workflow is written (`.github/workflows/release.yml`, `scripts/build.mjs`) but not yet proven by a real tagged build: its Docker `image`/`chip` modes have run only in design, not on a runner. Standing invariants 4 and 5 stay `pending (LEDGER)` until `v0.0.1` builds green in CI; the two rows flip to `verified_by` at the slice-0002 freeze. (ADR-0001)
- [deferred] Byte-for-byte reproducibility gate (ADR-0001 section 6: a tag rebuild compares byte-for-byte against the prior build of the same tag) is not implemented: it needs a prior-build store the v0.0.1 pipeline does not stand up. Related: pin #5 (builder image ID) only attests the image used, because the Dockerfile's apt/pip layers are unpinned, so image rebuilds are not bit-identical; freezing those layers is part of making the image a reconstruction input. The five-pin manifest is the interim provenance guarantee. (ADR-0001)
- [bug] Not every floating input is pinned yet. Direct: esp32-camera (floating `master`) and esp-sr are still unpinned managed components (neither has broken a build, but same latent risk; pin via `managedComponentPins` with the blob's versions.txt when needed). Transitive: the component manager still resolves esp-dsp, esp-modbus, the rmaker tree, etc. under esp_matter/arduino without a committed lock; capturing the build's generated `dependencies.lock` is the remaining full-reproducibility step. esp-tflite-micro, esp_matter, and the IDF/arduino/tinyusb commits are now pinned (ADR-0004, ADR-0005). (ADR-0005)
- [deferred] Upstream-reachability mirror: the thin-overlay build depends on `espressif/esp32-arduino-lib-builder` staying reachable at the pinned commit. An optional source mirror is deferred until a need appears; the immutable SHA pin is the interim guarantee (ADR-0001). (ADR-0001)
- [deferred] Patch #4 `supplicant-pmkid-path` awaits its consumer-driven ADR before it can be designed (adversary:ADR-0137). (ADR-0001)
- [deferred] Patch #5 `panic-hook-wrap-chain` awaits its consumer-driven ADR before it can be designed (adversary:ADR-0135, adversary:ADR-0136). (ADR-0001)

## Resolved

Entries move out of "Open" by deletion. A narrative of what merely *happened* belongs in
the git log; what belongs on an open item is evidence it cannot be re-derived later — a
measured result, a reproduction, a count the eventual decision turns on. Keep that with
the item while it is open, and move it into the ADR that closes it. What this file is not
is a record of completed work.
