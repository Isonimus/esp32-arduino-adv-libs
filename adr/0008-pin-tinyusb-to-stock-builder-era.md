---
id: '0008'
title: "Pin tinyusb to the stock builder's era, not the reference blob's"
type: architecture
status: accepted
date: 2026-11-13
supersedes: []
superseded_by: []
---

## Context

With C++20 forced (ADR-0007), run `43513459721` (commit `b03ff6c`) built **esp32 fully green
for the first time**, and got esp32s3 deep into the compile (~14 minutes, past the toolchain and
most components) before failing in `components/arduino_tinyusb/src/dcd_dwc2.c`, the DWC2 USB
device driver:

```
dcd_dwc2.c:105: error: 'dwc2_regs_t' has no member named 'ghwcfg2_bm'; did you mean 'ghwcfg4_bm'?
dcd_dwc2.c:388: error: 'dwc2_regs_t' has no member named 'dsts_bm'; did you mean 'dsts'?
dcd_dwc2.c:700: error: 'dwc2_regs_t' has no member named 'dcfg_bm'; did you mean 'dcfg'?
dcd_dwc2.c:807: error: 'dwc2_dep_t' has no member named 'tsiz_bm'; did you mean 'tsiz'?
dcd_dwc2.c:479: error: too few arguments to function 'dcd_edpt_xfer'
dcd_dwc2.c:601: error: conflicting types for 'dcd_edpt_xfer'
```

esp32 (classic) has no DWC2 USB OTG peripheral, so it never compiles this file; esp32s3 does.
That is why esp32 passed and only esp32s3 reached the failure.

That `dcd_dwc2.c` belongs to the **lib-builder**, not to arduino-esp32. arduino-esp32 at the
pinned `9b3364c6` has no `components/` tree and no tinyusb at all; the `arduino_tinyusb` component
(`CMakeLists.txt`, `include/`, `patches/`, and the vendored `src/dcd_dwc2.c`) lives in the
lib-builder repo (pin `e68e301`). The stock builder clones `hathach/tinyusb` at **unpinned
`master`** (`tools/update-components.sh`) into `components/arduino_tinyusb/tinyusb`, then compiles
its own vendored `src/dcd_dwc2.c` against the headers from that clone. The vendored driver and the
cloned tinyusb headers must come from the same tinyusb era, or the driver references struct members
and a function signature the headers do not have.

Measured on 2026-11-13:

| tinyusb | date | `ghwcfg2_bm` etc. in `dwc2_type.h` | `dcd_edpt_xfer` |
|---|---|---|---|
| stock builder's vendored `dcd_dwc2.c` (`e68e301`, last changed 2024-12-18) | Jan 2025 era | **uses** `ghwcfg2_bm` (x3), `dsts_bm`, `dcfg_bm`, `grxstsp_bm`, `tsiz_bm` | **calls** the 4-arg form |
| `91214b46` (master HEAD at `e68e301`'s commit time, 2025-01-21) | 2025-01-21 | **defines** all of them | **declares** 4 args |
| `93b53158` (the current pin, from the blob) | 2025-12-05 | **defines none** | **changed signature** |

By late 2025 upstream tinyusb had refactored the DWC2 registers away from the `_bm` bitfield-mask
API and changed `dcd_edpt_xfer`'s signature. The builder's Jan-2025 vendored driver cannot compile
against Dec-2025 headers: hence "no member named" and "conflicting types / too few arguments".

This is the ADR-0005 premise failing for tinyusb. ADR-0005 pinned all three sources to the blob's
2025-12-05 `versions.txt` snapshot on the belief it was one mutually-consistent set. It is
consistent with the blob's **builder** (bmorcelli's lib-builder fork, whose contemporaneous vendored
`arduino_tinyusb/src/dcd_dwc2.c` was Dec-2025 era, matching Dec-2025 tinyusb). It is **not**
consistent with **our** builder: we build with the stock espressif lib-builder `e68e301` (ADR-0001),
whose vendored driver is Jan-2025 era. The IDF pin (a plain ancestor of `release/v5.5`) and the
arduino pin (the espressif base source both builders compile, ADR-0005 Amendment) happen to be
compatible with our builder across that calendar gap; tinyusb is not, because the stock builder is
the one place that **couples a vendored source file to the floating input it clones**.

## Decision

Pin `sourcePins.tinyusbCommit` to `91214b46142186b6c30ea468779c7ad39e1bc605`: tinyusb `master`
HEAD at the `e68e301` builder's own commit timestamp (`91214b46` is 2025-01-21T09:28:29Z, hours
before `e68e301`'s 2025-01-21T15:37:52Z). This is the version the stock builder would itself have
cloned when that builder commit was cut, and the version its vendored `dcd_dwc2.c` compiles against;
every member and the 4-arg `dcd_edpt_xfer` were verified present at it. It is reachable from `master`
(a strict ancestor: `master` is ahead 3122, behind 0), so a plain clone contains it, satisfying
ADR-0005's reachability requirement.

The correct anchor for a source pin is the **stock builder's era, not the reference blob's**. The
blob is a shape-and-version *reference* (what the consumers' libs must look like), not a build input:
we do not build with its builder. Where the stock builder vendors source coupled to a floating input,
the pin must match the builder; the blob's value for that input is right only when the two builders'
eras coincide, which held for IDF and arduino and did not for tinyusb.

No `scripts/build.mjs` change: `pinBuildSources` already force-checks-out whatever `tinyusbCommit`
names (ADR-0005). This is a pin-value correction and its record, not a mechanism change.

This does **not** supersede ADR-0005. ADR-0005's decision (pin every floating input to an exact,
reachable commit; the `build.sh` injection mechanism) stands unchanged, as do its IDF and arduino
pins. ADR-0005 keyed one of its three values to the wrong era; this ADR corrects that one value and
states the era-coherence principle ADR-0005 missed. It is the same class of correction as ADR-0005's
own arduino amendment (prefer the builder-coherent, upstream-native anchor over the blob's recorded
SHA), carried one input further: there, the blob's SHA was byte-identical source to a reachable
espressif base; here, the blob's tinyusb is a genuinely different version than our builder needs, so
matching the builder means a different commit, not merely a different ref for the same source.

## Consequences

- esp32s3 compiles `arduino_tinyusb` against headers that match the builder's vendored driver. This
  is the next config-divergence blocker cleared; the build either completes or reveals a genuinely
  new failure deeper in the esp32s3 compile.
- tinyusb now diverges from the blob (Jan 2025 vs Dec 2025). The USB device-stack internals differ,
  but the `arduino_tinyusb` public API the consumers use comes from the builder glue plus
  arduino-esp32 and is unchanged; the consumers need libs shaped like the blob, not a byte-identical
  USB stack. This is the tradeoff ADR-0005's arduino amendment already accepted, applied to one more
  input.
- esp32 built green on the prior pin because it never compiles the DWC2 driver, and tinyusb is cloned
  and checked out identically for both chips, so the change is expected to leave esp32 green; the next
  run is the proof, as for every source pin (there is no unit test for a pin value; the build is the
  verification, LEDGER/§4 invariant 4).
- The still-unpinned managed components (`esp32-camera`, `esp-sr`; LEDGER) carry this same era
  coherence risk, not only the reachability risk: when pinned, they must be pinned to the stock
  builder's era, not the blob's. The LEDGER item is updated to record that.
