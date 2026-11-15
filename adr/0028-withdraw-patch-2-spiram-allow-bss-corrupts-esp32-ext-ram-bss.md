---
id: '0028'
title: "Withdraw patch #2 (spiram-allow-bss-ext): it corrupts the esp32 core's .ext_ram.bss, and its one consumer use was infeasible anyway"
type: architecture
status: accepted
date: 2026-11-15
supersedes: ['0021']
superseded_by: []
---

## Context

ADR-0021 enabled `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` on the esp32 libs (patch #2), so a
consumer could tag a large static buffer `EXT_RAM_BSS_ATTR` and have it land in PSRAM-backed
`.ext_ram.bss` instead of overflowing DRAM `.bss`. slice-0022 shipped it in release `v0.1.0`, the
drop-in both consumer firmwares were to adopt. ADR-0021 decision 4 made the per-chip *link* the machine
check; decision 5 deferred the one unproven behaviour (PSRAM boot on the owned libs) to an on-device
proof "the operator's to run." The link passed and the native suites passed, and `v0.1.0` was cut,
published, and adopted by `esp32-wifi-sapper` (`esp32-wifi-sapper:ADR-0121` / slice-0122). The on-device
run is what caught the defect the link could not, and it is a serious one.

**Measured on hardware (2026-11-15): `v0.1.0` crash-loops every esp32 board.** On the consumer side,
`esp32-wifi-sapper:ADR-0123` recorded the reproduction: the plain `v0.1.0` firmware `LoadProhibited`
panics on the `m5stickc_plus2` (esp32 + 2 MB PSRAM, `EXCVADDR=0xaaaaa9dc`, the `0xaa` uninitialised-memory
fill, faulting on objects in the `0x3f8019xx` PSRAM `.ext_ram.bss` range) and on the `cyd_3248s035c`
(esp32, no PSRAM, `EXCVADDR=0xa4a52019`), an identical crash loop on a board class the `atom_echo` shares.
The esp32s3 boards (`t_embed`, `cardputer`) were unaffected, because patch #2 is esp32 only. Both esp32
boards booted clean the moment the consumer reverted to the Bruce blob.

**Root cause (confirmed, not assumed).** Patch #2 makes the `EXT_RAM_BSS_ATTR` macro active on esp32. That
is not limited to consumer buffers: it relocates the **Arduino core's own** `EXT_RAM_BSS_ATTR` globals
(~16 KB, measured) into `.ext_ram.bss` at PSRAM addresses (`0x3f800000+`). But our esp32 libs also ship
PSRAM boot-init **off** (`# CONFIG_SPIRAM_BOOT_HW_INIT is not set`), the same PSRAM-less-reference-board
safety ADR-0015 applies on esp32s3, carried on esp32 too. So PSRAM comes up late, via Arduino's
`psramInit()`, and the `.ext_ram.bss` segment is **never zeroed** at boot. The core then reads an
uninitialised pointer out of `.ext_ram.bss` and dereferences the `0xaa` fill. `ALLOW_BSS=y` with PSRAM
not initialised at boot is an **invalid sdkconfig combination**: the two defconfig appends
(`ALLOW_BSS=y` here, `SPIRAM_BOOT_HW_INIT` left unset) are each defensible alone and mutually
incompatible on esp32. The Bruce blob shipped `ALLOW_BSS` **unset**, so `EXT_RAM_BSS_ATTR` was a no-op
and the core's globals sat in normal, zeroed internal DRAM `.bss`: that is why every esp32 board worked
before `v0.1.0`.

The consumer-side probe that found this (`esp32-wifi-sapper:ADR-0123`) also measured a **POD**
`EXT_RAM_BSS_ATTR` buffer placed at `0x3f800000`, writable but reading back **non-zero**
(`bytesum=141016`), directly confirming `.ext_ram.bss` is not zeroed under this config.

This corrects the central safety claim of ADR-0021. ADR-0021 called patch #2 "a pure opt-in ... It
changes where a symbol lives *only* for symbols explicitly tagged `EXT_RAM_BSS_ATTR` in source; IDF and
Arduino core tag none by default." The second half is false, measured: the Arduino core **does** tag
globals `EXT_RAM_BSS_ATTR`, so the flag is not opt-in. It changes where the core's own globals land the
moment it is set, into memory this build never zeroes, on every esp32 board whether or not a consumer
ever uses the attribute. The "no change to a consumer that does not use `EXT_RAM_BSS_ATTR`" consequence
is therefore also false.

**And the one consumer use the flag existed for was independently infeasible.** Patch #2's sole driver was
`esp32-wifi-sapper:ADR-0080`, which wanted to place its `CrackedManifest` buffers statically in
`.ext_ram.bss` and so retire its runtime `heap_caps_malloc(..., MALLOC_CAP_SPIRAM)` placement. The
consumer's own feasibility probe (recorded in `esp32-wifi-sapper:ADR-0123`) showed that static form cannot
work for this firmware regardless of the flag: `CrackedManifest` is polymorphic with a store-bearing
constructor that runs during C++ static init, **before** the late `psramInit()`, so a static
`.ext_ram.bss` manifest would be constructed against unmapped PSRAM. The runtime `MALLOC_CAP_SPIRAM`
route is the end-state mechanism on esp32 PSRAM boards, not an interim one. So patch #2 delivers **no
usable benefit** to the only consumer that drove it, and one real harm.

No other consumer uses the flag. Measured 2026-11-15 across both sibling trees: `esp32-wifi-sapper` has
zero `EXT_RAM_BSS_ATTR` uses in source (its single mention is prose in `esp32-wifi-sapper:ADR-0080`'s
standing-invariant row, which already records the static form as unavailable and deferred), and
`adversary` has zero references to `EXT_RAM_BSS_ATTR` or the flag anywhere. Withdrawing patch #2 removes a
capability that no shipping or reachable consumer code uses.

## Decision

**Withdraw patch #2 (`sdkconfig-spiram-bss-ext`) from the overlay. It is not built.** Patch #1 (the weak
`ieee80211_raw_frame_sanity_check`, ADR-0019) is unaffected and stays: it is correct and in demand.

Concretely, in this repo:

1. **Remove the defconfig append.** Drop `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` from
   `UPSTREAM.lock`'s `addedDefconfigLines["defconfig.esp32"]`, leaving `CONFIG_ESP32_REV_MIN_3=y`
   (ADR-0013) in place. The esp32 base `sdkconfig` and both variant headers return to
   `# CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY is not set`, so `EXT_RAM_BSS_ATTR` is a no-op again and
   the core's globals sit in zeroed internal DRAM `.bss`, as on the Bruce blob.

2. **Retire the verify and its invariant.** Delete `scripts/0022-verify.mjs` and its `verify:spiram-bss`
   wiring in `package.json`, and remove standing invariant 12 from `CLAUDE.md` section 4. There is nothing
   left to assert once the flag is gone; `scripts/0014-verify.mjs` continues to assert that whatever
   `addedDefconfigLines` *does* contain (now just REV_MIN_3) lands in the resolved config, so a future
   re-addition of the flag would still be checked for landing, just no longer required to be present. The
   invariant-12 row is removed rather than renumbered: invariant 13 (ADR-0026) keeps its number so its
   citations do not dangle, and the gap at 12 marks a withdrawn rule.

3. **Cut a new release carrying patch #1 alone, and yank `v0.1.0` as a consumer target.** `v0.1.0` bricks
   every esp32 board and must not be adopted; the re-release (patch #1 only) is the drop-in the consumers
   take instead. slice-0029 is the shipping unit.

4. **On-device boot is a required release gate, not a deferred proof.** ADR-0021 decision 5 deferred the
   esp32 boot proof to "the operator's to run," and that deferral is exactly what let an invalid-sdkconfig
   release ship green and reach consumers. A release that changes any sdkconfig or libs surface is not
   proven until it boots on real hardware of each affected chip family. The next release that touches the
   esp32 config boots at least one esp32 board (and, for a change touching esp32s3, one esp32s3 board)
   **before** it is tagged, not after. This mirrors `esp32-wifi-sapper:ADR-0123` decision 4 on the
   consumer side; recorded here so the producer carries the same gate.

Unlike patches #3, #4 and #5 (withdrawn for no demand or infeasibility before they ever shipped, ADR-0023
/ ADR-0024 / ADR-0025), patch #2 **shipped** and did harm, so this withdrawal removes a built overlay
operation, a wired verify, a standing invariant, and a published release's fitness, not just a roadmap
entry. That is why it carries a slice (slice-0029): there is a changed artifact to build and an on-device
result to record, which the demand-only withdrawals had none of.

**Reopen condition.** Reopen patch #2 only if a consumer ADR asks for static `EXT_RAM_BSS_ATTR` placement
*and* the release that would carry it also makes `.ext_ram.bss` valid on the target: either PSRAM
boot-init on at boot (which ADR-0015 keeps off on esp32s3 for the PSRAM-less reference board, so this
would need a PSRAM-guaranteed board class and its own driving ADR) or an equivalent early-zeroing of the
segment before static init reads it. Setting `ALLOW_BSS=y` while PSRAM is brought up late is the invalid
combination this ADR exists to record; a reopen that repeats it is the same bug.

## Consequences

- **The esp32 libs return to known-good.** With the append gone, the esp32 core's globals are back in
  zeroed DRAM `.bss` and the esp32 crash loop is gone. The re-release boots on esp32 again, which the new
  on-device gate (decision 4) proves before tagging.
- **ADR-0021 carries `superseded_by: ['0028']`; slice-0022 is superseded by slice-0029.** The adoption,
  its measured link evidence, and the on-device finding live on in those immutable records and in this
  ADR; nothing is deleted. A literal `git revert` of the patch #2 commits would erase exactly the record
  this workflow exists to keep.
- **The roadmap patch stack is fully resolved, now with a shipped-then-withdrawn case.** Patch #1 ships;
  patches #2, #3, #4 and #5 are all withdrawn (patch #2 here for a shipped defect, the others before
  shipping). "The roadmap named it" has now failed as evidence of a patch's fitness four times out of
  five; a future patch #6 starts from its own consumer ADR and its own on-device proof, not from the
  ADR-0001 section 7 roadmap or the INIT.md charter.
- **Consumers re-adopt against the patch-#1-only release.** `esp32-wifi-sapper` re-runs its hook
  retirement (`esp32-wifi-sapper:ADR-0123` names re-adoption as blocked on this withdrawal), boot-testing
  an esp32 board before merge; `adversary`, which never adopted `v0.1.0`, adopts the re-release directly.
  That is consumer work tracked in the sibling repos, not here.
- **`esp32-wifi-sapper:ADR-0080`'s static-attribute supersession path is permanently closed for the
  polymorphic manifest**, on two independent grounds now recorded: the attribute form cannot run before
  late `psramInit()` (the constructor-ordering fact), and the flag that was to enable it is itself unsafe
  on this build. The runtime `MALLOC_CAP_SPIRAM` route is the end state. That is a consumer-side note for
  the sibling repo's ledger.
- **No `dependencies.lock` change.** Patch #2 is an sdkconfig flag, not a resolved component, so it never
  appeared in either chip's `reference/dependencies.lock.<chip>`; the drift gate (invariant 13, ADR-0026)
  is untouched by the withdrawal.
- ADR-0001 is not superseded: its fork model, release shape, and remaining invariants stand. This ADR
  withdraws one sdkconfig overlay, one standing invariant, and one verify script, and corrects ADR-0001
  section 7's patch #2 entry in prose rather than by editing the immutable roadmap, as ADR-0019/0023/0024/
  0025 did for the other patches.
