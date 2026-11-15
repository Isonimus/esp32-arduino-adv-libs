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

- [deferred] Full toolchain bit-determinism of the release *payload* is deferred, not the whole reproducibility gate: ADR-0026 re-scoped ADR-0001 section 6, withdrawing the byte-for-byte artifact compare (unsatisfiable: `scripts/build.mjs` bakes the build date into the zip name and `builtOn` into `manifest.json`; disproportionate: the builder image apt/pip layers are unpinned so pin #5 only attests the image, and the IDF/GCC build is not bit-pinned) and adopting the resolved-dependency drift gate (invariant 13, `scripts/0027-verify.mjs`, slice-0027) plus the five-pin manifest as the reproducibility guarantee. What stays deferred is making the payload byte-reproducible: pinning the image apt/pip layers (snapshot.debian.org + pip hashes), `SOURCE_DATE_EPOCH` + deterministic `ar` + `-ffile-prefix-map`, zip normalisation, and a prior-build store to diff against. Disproportionate for a two-consumer appliance today; reopen if a consumer needs bit-identical rebuild attestation. (ADR-0026)
- [deferred] Upstream-reachability mirror: the thin-overlay build depends on `espressif/esp32-arduino-lib-builder` staying reachable at the pinned commit. An optional source mirror is deferred until a need appears; the immutable SHA pin is the interim guarantee (ADR-0001). (ADR-0001)
- [deferred] Patch #3 `wifi_ap_record-pmf-bits` is withdrawn as an overlay: the scan-record fill (`esp_wifi_scan_get_ap_records`) is `T` in the closed `libnet80211.a` the builder copies verbatim, so no sdkconfig, header edit, or objcopy can put an AP's PMF bits on `wifi_ap_record_t` (measured 2026-11-15, ADR-0023); and the one driver `adversary:ADR-0153` reads PMF off the RSN IE by design and declares no dependency on the archive. The only remaining path is an upstream change to Espressif's `esp-wifi-lib`, out of this repo's overlay scope and unrequested; parked here, not work. (ADR-0023)
- [deferred] Patch #4 `supplicant-pmkid-path` is withdrawn as an overlay for no demand, not infeasibility: measured 2026-11-15, `libwpa_supplicant.a` is source-compiled from the open IDF `wpa_supplicant` component (83 `*.c.obj` members, `components/wpa_supplicant/...` source paths), so a supplicant EAPOL-M1/PMKID hook would be a feasible source patch, unlike patch #3's closed blob. But the one driver `adversary:ADR-0137` evaluated the managed-association/supplicant route (Option A), rejected it, and shipped injected-association clientless PMKID (Option B) proven on-device (`adversary:ADR-0138`). Reversible: reopen only if a consumer ADR asks for the managed-association PMKID path (ADR-0024). (ADR-0024)
- [deferred] Patch #5 `panic-hook-wrap-chain` is withdrawn as an overlay for no demand, not infeasibility: measured 2026-11-15, `libesp_system.a` is source-compiled from the open IDF `esp_system` component (31 of 37 members `*.c.obj`, `panic.c.obj` / `panic_handler.c.obj`, `components/esp_system/...` source paths, `esp_panic_handler` strong-defined `T` intra-archive), so a panic-hook source patch is feasible, unlike patch #3's closed blob. But the one driver `adversary:ADR-0135` was superseded by `adversary:ADR-0136`, which proved on-device that the `--wrap` hook is inert against the precompiled archive and that the masked-crash blind spot is a tethered-host artifact (standalone panics reset as `ESP_RST_PANIC` and log correctly; the `ESP_RST_USB` masking only occurs with a host attached, where the backtrace is already live on the console), and added no code mitigation. Reversible: reopen only if a consumer ADR asks for a panic-time instrumentation point (ADR-0025). (ADR-0025)

## Resolved

Entries move out of "Open" by deletion. A narrative of what merely *happened* belongs in
the git log; what belongs on an open item is evidence it cannot be re-derived later — a
measured result, a reproduction, a count the eventual decision turns on. Keep that with
the item while it is open, and move it into the ADR that closes it. What this file is not
is a record of completed work.
