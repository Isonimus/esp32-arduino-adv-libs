---
id: '0023'
title: "Withdraw roadmap patch #3 (wifi_ap_record PMF bits): the scan-record fill is a closed blob and the consumer already self-solved"
type: architecture
status: accepted
date: 2026-11-15
supersedes: []
superseded_by: []
---

## Context

ADR-0001 section 7 sequences patch #3 as `wifi_ap_record-pmf-bits` (release `v0.3.0`): make
the shipped libs expose an access point's Protected Management Frames (PMF) capability and
requirement bits on the Wi-Fi scan record, so a consumer can read them from the record
instead of parsing the RSN information element by hand. The intended driver is
`adversary:ADR-0153` (PMF-aware attack selection and 802.11v BTM steering), whose slice
needs two bits per scanned network: `pmfCapable` and `pmfRequired`.

Before designing any overlay, the feasibility of "expose PMF on the scan record from the
build" was probed on 2026-11-15, against the patch #2 release artifact
(`adv-esp32-arduino-libs-v5.5-20261114-e68e301`) and the pinned IDF builder tree
(`espressif/esp-idf` at the `release/v5.5` pin, `components/esp_wifi`). Three measurements
decide it:

1. **The shipped struct carries no PMF field.** `wifi_ap_record_t` in the shipped
   `esp32/include/esp_wifi/include/esp_wifi_types_generic.h` (the AP description a scan
   returns) runs lines 314 to 343 and holds bssid, ssid, channel, rssi, `authmode`,
   pairwise/group cipher, phy flags, country, HE-AP info and bandwidth, plus a `reserved: 22`
   bitfield. It has no PMF member. The only `wifi_pmf_config_t pmf_cfg` in the header sits on
   the station-side config structs (how the device advertises PMF when it joins an AP), not
   on what a scanned AP advertises back.

2. **No sdkconfig symbol exposes PMF on the scan record.** The only PMF references in
   `components/esp_wifi/Kconfig` (lines 307 and 339) describe the station WPA3-connection
   prerequisite. There is no build option that adds the AP's PMF capability/requirement to
   `wifi_ap_record_t`. Patch #2 was a one-line sdkconfig append (ADR-0021); this has no such
   lever.

3. **The code that fills the record is a closed binary blob the builder never compiles.**
   `esp_wifi_scan_get_ap_records` is declared in the open `esp_wifi/include/esp_wifi.h` and
   called from `wifi_apps/roaming_app/src/roaming_app.c`, but no open-source `.c` in IDF
   defines it; `nm` resolves it to `00000020 T esp_wifi_scan_get_ap_records` inside
   `components/esp_wifi/lib/esp32/libnet80211.a` (a 1.5 MB, 50-object archive). That `lib/`
   directory is the `esp-wifi-lib` git submodule (`.gitmodules` entry
   `components/esp_wifi/lib`) that the builder copies verbatim and never compiles, the same
   closed net80211 blob patch #1 had to reach with `objcopy` (ADR-0019, UPSTREAM.lock
   `weakenArchiveSymbolsComment`). No open IDF source anywhere parses an AP's RSN
   capabilities or MFP bits into any record; that parse happens inside the blob during
   scan-done handling.

Taken together: the only place PMF-from-RSN could be written onto the scan record is inside
closed net80211 object code the overlay cannot touch. Adding a field to the header is
possible but would stay unfilled; an sdkconfig flag does not exist; and the patch #1 lever
(`objcopy --weaken-symbol`) can rename or weaken a symbol but cannot inject RSN parsing into
the blob. There is no overlay mechanism that produces the patch #3 effect.

This is patch #1's lesson again (ADR-0019: the roadmap's "declare the symbol weak in source"
was impossible against a vendored blob), one step worse: patch #1 still had a blob-level
lever; patch #3 has none short of changing the closed library's logic.

**The consumer has also already solved it without the libs, by design.** `adversary:ADR-0153`
Decision parses the two PMF bits directly off the RSN IE and its slice ships a short
promiscuous beacon-sniff pass that runs after the normal scan. That slice probed this exact
toolchain on 2026-11-13 and reached measurement 1 above independently. Crucially, unlike
`esp32-wifi-sapper:ADR-0080` (patch #2) and the deauth workaround (patch #1), which named
this initiative as their supersession condition, `adversary:ADR-0153` Consequences states the
opposite as a design choice: "No new dependency on the precompiled wpa_supplicant archive:
PMF parsing is a 2-bit read off the RSN IE already in hand." The consumer does not want this
patch; it chose the raw-frame read.

## Decision

**Withdraw patch #3 (`wifi_ap_record-pmf-bits`) from the overlay patch stack. It is not
built.** Two independent reasons, each sufficient:

1. **Infeasible as an overlay.** Exposing an AP's PMF bits on `wifi_ap_record_t` requires
   changing the scan-record fill logic, which lives in the closed `libnet80211.a` the builder
   copies and never compiles (measurement 3). No sdkconfig, header edit, or archive-symbol
   rewrite produces the effect. The overlay toolchain has no lever here.

2. **No consumer demand.** The one driver, `adversary:ADR-0153`, deliberately reads PMF off
   the RSN IE and declares no dependency on the precompiled archive. There is no firmware
   waiting on this patch to retire a workaround, because the consumer did not build a
   workaround: it built its chosen mechanism.

This mirrors how ADR-0019 handled patch #1's broken premise: the roadmap bullet is corrected
by this record, not by editing immutable ADR-0001. ADR-0001 section 7's release sequence
stands as the historical plan; this ADR is the measured correction to its patch #3 entry.

The only path that could ever produce PMF-on-the-scan-record is an upstream change to
Espressif's closed `esp-wifi-lib` (the net80211 scan handler and the `wifi_ap_record_t`
definition), landed in a tagged IDF the builder then pins. That is Espressif's source to
change, not an overlay this repo can carry, and no consumer is asking for it. It is recorded
as a parked possibility in `LEDGER.md`, not as work.

## Consequences

- **Patch #3 is not built, and `v0.3.0` does not carry it.** The next overlay patch to ship
  is whichever of patches #4 (`supplicant-pmkid-path`, `adversary:ADR-0137`) or #5
  (`panic-hook-wrap-chain`, `adversary:ADR-0135`, `adversary:ADR-0136`) has a ready consumer
  ADR and a feasible in-build mechanism. Each still needs its own feasibility probe before
  design: patch #3 is the second roadmap entry (after patch #1) whose premise did not survive
  contact with the binary blobs, so "the roadmap named it" is not evidence it is buildable.
- **No new standing invariant, no slice, no `patches/` entry.** Nothing ships, so there is
  nothing to guarantee or verify. The probe answered its question once and its numbers live
  in this ADR (the probe-in-an-ADR discipline, repo rule 3); no `scripts/*-verify.mjs` is
  added.
- **A LEDGER line records the single remaining path** (PMF-on-scan-record is reachable only
  by an upstream change to the closed `esp-wifi-lib`, out of this repo's overlay scope),
  citing this ADR, so a future reader does not re-attempt the overlay that measurement 3
  already ruled out.
- **The consumer keeps its raw-frame read.** `adversary:ADR-0153` and its slice are
  unaffected; they never depended on this repo. Nothing in that firmware changes because of
  this decision.
- ADR-0001 is not superseded: its fork model, tracking policy, release shape, and invariants
  stand. This ADR corrects one bullet of its roadmap with measured evidence, exactly as
  ADR-0019 did for patch #1.
