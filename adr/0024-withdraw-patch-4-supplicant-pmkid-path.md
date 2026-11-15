---
id: '0024'
title: "Withdraw roadmap patch #4 (supplicant PMKID path): feasible as a source patch, but the one driver declined the supplicant route and shipped frame injection"
type: architecture
status: accepted
date: 2026-11-15
supersedes: []
superseded_by: []
---

## Context

ADR-0001 section 7 names patch #4 `supplicant-pmkid-path`, following patch #3 once its consumer
ADR is ready. The intended effect: patch the shipped wpa_supplicant so it exposes a raw
EAPOL-M1 / PMKID path during a managed station association, enabling the "managed-association"
route to clientless PMKID that the precompiled Bruce libs block. The adversary LEDGER records
the blind spot as its motivation: "the precompiled wpa_supplicant exposes no raw EAPOL-M1/PMKID
path, which rules out a managed-association route to clientless PMKID and forces the
frame-injection approach (`adversary:ADR-0137`)."

Patch #4 was probed on 2026-11-15 on two axes, feasibility and demand, against the same v0.0.2
artifact patch #3 was measured on (`adv-esp32-arduino-libs-v5.5-20261114-e68e301`).

**Feasibility: the supplicant is source-compiled, not a closed blob.** `libwpa_supplicant.a`
ships in `esp32/lib/`. Its 83 members are named `*.c.obj` (the IDF compiled-object convention)
and the archive carries baked-in source paths `components/wpa_supplicant/esp_supplicant/src/...`
(for example `esp_wpa_main.c`, `esp_wpas_glue.c`, the crypto and SAE objects). That is the
builder compiling the open IDF `wpa_supplicant` component from source. This is the opposite of
patch #3's wall: `libnet80211.a` members are `*.o` with zero `components/*.c` strings, the
closed `esp-wifi-lib` submodule blob the builder copies verbatim (ADR-0023 measurement 3,
ADR-0019). So a supplicant EAPOL-M1 / PMKID hook would be a legitimate in-build **source patch**
(standing invariant 3's default path), not an `objcopy` carve-out and not infeasible. On the
feasibility axis alone, patch #4 is the sdkconfig-or-source patch the roadmap imagined.

**Demand: the one driver evaluated the supplicant route and rejected it, by design.**
`adversary:ADR-0137` (2026-11-03) is the consumer ADR patch #4 was waiting on. It weighed exactly
two mechanisms for clientless PMKID:

- **Option A, managed STA association through the supplicant** (the route patch #4 enables). It
  rejected A on two grounds: the precompiled supplicant surfaces no raw M1 / PMKID callback, and
  promiscuous mode does not run concurrently with a managed connection on this driver, so the
  PMKID never reaches the consumer's `recordPmkid`.
- **Option B, injected association**: stay in promiscuous mode, inject an 802.11 auth frame then
  an association request carrying an RSN IE, and read the AP's M1 off the promiscuous RX already
  in use. It **chose B**, gated behind an on-device feasibility spike.

`adversary:ADR-0138` (2026-11-04) records that the spike **passed**: against a real
PMKID-emitting AP, an injected blind auth + association pair from a spoofed STA MAC drew an EAPOL
M1 carrying a PMKID KDE, it was stored keyed on the spoofed MAC, and the saved `.22000` cracked.
Clientless PMKID then **shipped**: blind-pair solicitation, the frame builders promoted to
`src/utils/` with native byte-exact tests, and a third top-level `Clientless` handshake mode. The
feature is built and working with no dependency on the supplicant.

Crucially, `adversary:ADR-0137`'s rationale for B over A survives a **patched** supplicant: "B keeps the
single radio in promiscuous mode throughout, so it reuses the frame-injection and capture
plumbing already in `HandshakeCapture` instead of introducing a connect/promiscuous mode
conflict." Exposing M1 from an owned supplicant removes A's first objection but not the mode
switch A requires; the consumer chose the path that needs no managed connect at all. There is no
firmware waiting on this patch to retire a workaround, because the consumer did not build a
workaround around a missing supplicant hook: it built a different mechanism that never wanted one.

This differs from patch #3 on one axis and matches it on the other. Patch #3 (ADR-0023) was
withdrawn for two independent reasons, infeasible **and** unwanted. Patch #4 is **feasible** but
**unwanted**: the single reason that withdraws it is that its one driver declined the route and
shipped the alternative. A feasible patch no consumer wants is still not built.

## Decision

**Withdraw patch #4 (`supplicant-pmkid-path`) from the overlay patch stack. It is not built.**

The reason is no consumer demand, not infeasibility. The one driver, `adversary:ADR-0137`,
deliberately took the injected-association route (Option B), proved it on-device
(`adversary:ADR-0138`, spike passed 2026-11-04), and shipped clientless PMKID without any
dependency on a supplicant change. Building a supplicant PMKID hook would deliver a mechanism
(Option A, managed association) the consumer evaluated and rejected for a connect/promiscuous mode
conflict that persists even against a patched supplicant. Every patch in this stack cites a
consuming ADR that needs it (standing invariant 2); patch #4's consuming ADR actively declines it,
so the premise that gated it ("awaits its consumer-driven ADR before it can be designed") is
resolved in the negative.

Unlike patch #3, this withdrawal does **not** rest on a closed blob. The measured record is that
`libwpa_supplicant.a` is source-compiled and a supplicant hook is a feasible source patch; the
withdrawal is purely a demand decision, and is reversible the moment a consumer ADR asks for the
managed-association PMKID path. This is recorded so a future reader does not mistake "withdrawn"
for "impossible" here, as it would be for patch #3.

This mirrors how ADR-0019 (patch #1) and ADR-0023 (patch #3) corrected the roadmap: the ADR-0001
section 7 bullet is corrected by this record, not by editing immutable ADR-0001. ADR-0001's
release sequence stands as the historical plan; this ADR is the measured correction to its patch
#4 entry.

## Consequences

- **Patch #4 is not built.** The next overlay patch to consider is patch #5
  (`panic-hook-wrap-chain`, `adversary:ADR-0135`, `adversary:ADR-0136`), which still needs its own
  feasibility probe before any design: patch #4 is now the third roadmap entry (after #1 and #3)
  whose premise did not survive contact with the measured artifact, so "the roadmap named it" is
  not evidence it should ship.
- **No new standing invariant, no slice, no `patches/` entry.** Nothing ships, so there is nothing
  to guarantee or verify. The probe answered its two questions once and the numbers live in this
  ADR (the probe-in-an-ADR discipline, repo rule 3); no `scripts/*-verify.mjs` is added.
- **The LEDGER line is corrected, not deleted.** The prior "awaits its consumer-driven ADR"
  framing is replaced by the measured outcome: the driver exists, declined the supplicant route,
  and shipped frame injection; the patch is withdrawn for no-demand and is reversible if a future
  consumer ADR wants the managed-association path, citing this ADR.
- **The reopen condition is explicit and narrow.** Reopen patch #4 only if a consumer ADR asks for
  a managed-association PMKID path (for example an AP class the injected blind pair cannot solicit,
  found in the field). Because the supplicant is source-available, that patch would be a straight
  source hook, not a blob problem. No such consumer exists today.
- **The consumer keeps its injected-association path.** `adversary:ADR-0137` / `adversary:ADR-0138`
  and the shipped `Clientless` mode are unaffected; they never depended on this repo. Nothing in
  that firmware changes because of this decision.
- ADR-0001 is not superseded: its fork model, tracking policy, release shape, and invariants
  stand. This ADR corrects one bullet of its roadmap with measured evidence, exactly as ADR-0019
  and ADR-0023 did for patches #1 and #3.
