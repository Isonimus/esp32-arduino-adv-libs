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

- [deferred] Byte-for-byte reproducibility gate (ADR-0001 section 6: a tag rebuild compares byte-for-byte against the prior build of the same tag) is not implemented: it needs a prior-build store the v0.0.1 pipeline does not stand up. Related: pin #5 (builder image ID) only attests the image used, because the Dockerfile's apt/pip layers are unpinned, so image rebuilds are not bit-identical; freezing those layers is part of making the image a reconstruction input. The five-pin manifest is the interim provenance guarantee. (ADR-0001)
- [bug] Capture the build's generated `dependencies.lock` for full reproducibility: the component manager still resolves the transitive tree (esp-dsp, esp-modbus, the kept arduino deps, etc.) without a committed lock, so a rebuild could drift. `scripts/0012-verify.mjs` now reads this lock to assert the removals (ADR-0011), but it is not yet captured or pinned. (esp32-camera, the RainMaker tree and esp-sr are no longer floating risks: slice-0012 and slice-0018 removed them. The IDF/arduino/tinyusb source commits and esp-tflite-micro are pinned or removed; ADR-0004, ADR-0005, ADR-0008, ADR-0011, ADR-0017.) (ADR-0005)
- [deferred] Upstream-reachability mirror: the thin-overlay build depends on `espressif/esp32-arduino-lib-builder` staying reachable at the pinned commit. An optional source mirror is deferred until a need appears; the immutable SHA pin is the interim guarantee (ADR-0001). (ADR-0001)
- [deferred] Patch #4 `supplicant-pmkid-path` awaits its consumer-driven ADR before it can be designed (adversary:ADR-0137). (ADR-0001)
- [deferred] Patch #5 `panic-hook-wrap-chain` awaits its consumer-driven ADR before it can be designed (adversary:ADR-0135, adversary:ADR-0136). (ADR-0001)

## Resolved

Entries move out of "Open" by deletion. A narrative of what merely *happened* belongs in
the git log; what belongs on an open item is evidence it cannot be re-derived later — a
measured result, a reproduction, a count the eventual decision turns on. Keep that with
the item while it is open, and move it into the ADR that closes it. What this file is not
is a record of completed work.
