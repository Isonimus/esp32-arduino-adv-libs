---
id: '0025'
title: "Withdraw roadmap patch #5 (panic-hook-wrap-chain): feasible as a source patch, but the one driver measured the motivating blind spot away"
type: architecture
status: accepted
date: 2026-11-15
supersedes: []
superseded_by: []
---

## Context

ADR-0001 section 7 names patch #5 `panic-hook-wrap-chain`, the last entry in the roadmap's
patch stack, following patch #4 once its consumer ADR is ready. The intended effect: make
the shipped libs expose a panic-time instrumentation point that survives the final link, so a
consumer's panic hook actually fires. The adversary LEDGER records the blind spot as its
motivation: "the Arduino custom-panic hook is inert on the precompiled build (the final-link
`--wrap` never intercepts the real `esp_panic_handler`, reached directly inside the archive,
so panic-time instrumentation is impossible: `adversary:ADR-0135`/`adversary:ADR-0136`)."

Patch #5 was probed on 2026-11-15 on the same two axes as patches #3 and #4, feasibility and
demand, against the same v0.0.2 artifact (`adv-esp32-arduino-libs-v5.5-20261114-e68e301`).

**Feasibility: the panic path is source-compiled, not a closed blob.** `libesp_system.a`
ships in `esp32/lib/`. Of its 37 members, 31 are named `*.c.obj` (the IDF compiled-object
convention) and none are bare `*.o`; the panic path specifically ships as `panic.c.obj`,
`panic_handler.c.obj`, `panic_arch.c.obj` and `panic_handler_asm.S.obj`, and the archive
carries baked-in source paths `components/esp_system/panic.c`,
`components/esp_system/port/panic_handler.c`, and
`components/esp_system/port/arch/xtensa/panic_arch.c`. That is the builder compiling the open
IDF `esp_system` component from source. `esp_panic_handler` resolves to `00000000 T`
(strong, defined) inside this archive and `U` (imported) from a sibling member, so the real
handler is both defined and called **intra-archive**. This is the opposite of patch #3's wall
(`libnet80211.a`: bare `*.o` members, zero `components/*.c` strings, the closed `esp-wifi-lib`
blob the builder copies verbatim, ADR-0023 measurement 3, ADR-0019) and the same category as
patch #4's `libwpa_supplicant.a` (source-compiled, ADR-0024). So a panic-hook patch would be
a legitimate in-build **source patch** (standing invariant 3's default path), not an
`objcopy` carve-out and not infeasible.

The reason the consumer's `--wrap` is inert is exactly this intra-archive binding, and it is
*why* only a build-side change could help, not a reason it cannot: the exception path calls
`esp_panic_handler` through a reference already resolved inside `libesp_system.a` at
archive-assembly time, so the consumer's final-link `-Wl,--wrap=esp_panic_handler` has no
call site left to rewrite. A source patch to the open `esp_system` panic path (a real weak,
consumer-overridable hook compiled into the archive, or a restructure that leaves the wrap a
live call site) is the lever the consumer's link option cannot be. On the feasibility axis
alone, patch #5 is a buildable source patch.

**Demand: the one driver measured the motivating blind spot away.** `adversary:ADR-0135`
(2026-11-01) proposed stamping an RTC panic marker from a `--wrap=esp_panic_handler` hook, and
wrote in an on-device forced-panic acceptance gate because it flagged "the wrap may not fire
on a precompiled archive" as its one unproven assumption. `adversary:ADR-0136` (2026-11-01,
accepted, supersedes `adversary:ADR-0135`) ran that gate on real hardware and reversed the
decision on two independent grounds:

- **The mechanism is inert on the toolchain**, confirmed on device: with the hook registered
  and read back, a forced `abort()` and a forced stack-canary panic both ran to reboot without
  the callback firing. This is the `--wrap`-does-not-intercept-the-archive fact above, proven
  rather than assumed.
- **The motivating blind spot does not exist in the field.** The masked crash was a
  tethered-host artifact, not a universal blind spot. Measured directly: a standalone panic's
  reset reason is `ESP_RST_PANIC` and the existing classifier logs it to `crash.log`
  correctly. The boot only reads `ESP_RST_USB` (the value that was being swallowed) when a
  host toggles the reset line on the post-crash boot, for example a serial monitor
  reconnecting; and in that tethered case the panic and its backtrace are already live on the
  attached console. An A/B on device confirmed both halves.

`adversary:ADR-0136`'s Decision is therefore "do not implement the panic marker ... No code
mitigation is added," and it names the only reopen condition: "If a standalone-reproducible
crash ever surfaces that the reset reason genuinely cannot classify (not a tethered USB
artifact)," which would reopen the flash-core-dump path (`adversary:ADR-0126`), not a panic
hook. There is no firmware waiting on this patch: the consumer did not build a workaround
around a missing panic hook, it measured the problem the hook would have served and found
nothing left to capture in standalone operation.

The adversary LEDGER still lists the inert panic hook among the shared-libs initiative's
"concrete blind spots ... an owned build could re-wrap or expose." That is the initiative's
motivation enumerating a historical blind spot, not a live consumer ADR requesting the patch;
the governing terminal decision (`adversary:ADR-0136`) withdrew the need. An owned build
*could* expose the hook (the feasibility axis says so), but no consumer wants the thing it
would expose.

This matches patch #4 on the feasibility axis (source-compiled, feasible) and sharpens it on
the demand axis. Patch #4's driver (ADR-0024) wanted clientless PMKID and chose a different
mechanism, so its reopen condition is an AP class that needs the managed-association route.
Patch #5's driver concluded the capability serves a non-problem in the field, so its reopen
condition is narrower still: a standalone crash the reset reason genuinely cannot classify,
which `adversary:ADR-0136` would route to a core dump rather than a panic hook. A feasible
patch whose motivating problem the one consumer measured away is not built.

## Decision

**Withdraw patch #5 (`panic-hook-wrap-chain`) from the overlay patch stack. It is not built.**

The reason is no consumer demand, not infeasibility. The one driver, `adversary:ADR-0135`,
was superseded by `adversary:ADR-0136`, which proved on-device that the `--wrap` hook is inert
against the precompiled archive **and** that the blind spot it targeted is a tethered-host
artifact already handled live on the console, with standalone panics logged correctly by the
existing reset-reason classifier. It explicitly adds no code mitigation and names a narrow
reopen path (a standalone-unclassifiable crash, routed to a flash core dump, not a panic
hook). Every patch in this stack cites a consuming ADR that needs it (standing invariant 2);
patch #5's consuming ADR measured its own premise away, so the premise that gated it ("follows
when its consumer ADR is ready to drive it") is resolved in the negative.

Unlike patch #3, this withdrawal does **not** rest on a closed blob. The measured record is
that `libesp_system.a` is source-compiled and a panic-hook patch is a feasible source patch;
the withdrawal is purely a demand decision, and is reversible the moment a consumer ADR asks
for a panic-time instrumentation point. This is recorded so a future reader does not mistake
"withdrawn" for "impossible" here, as it would be for patch #3.

This mirrors how ADR-0019 (patch #1), ADR-0023 (patch #3) and ADR-0024 (patch #4) corrected
the roadmap: the ADR-0001 section 7 bullet is corrected by this record, not by editing
immutable ADR-0001. ADR-0001's release sequence stands as the historical plan; this ADR is the
measured correction to its patch #5 entry.

## Consequences

- **Patch #5 is not built, and the roadmap patch stack is now fully resolved.** Patch #5 was
  the last entry in ADR-0001 section 7. Patches #1 and #2 shipped; patches #3, #4 and #5 were
  each withdrawn after a measured probe (ADR-0023, ADR-0024, this ADR). There is no next
  overlay patch to consider: the stack is exhausted, and "the roadmap named it" has now failed
  as evidence of buildability or demand three times out of five. A future patch #6 would start
  from its own consumer ADR and its own feasibility probe, not from this roadmap.
- **No new standing invariant, no slice, no `patches/` entry.** Nothing ships, so there is
  nothing to guarantee or verify. The probe answered its two questions once and the numbers
  live in this ADR (the probe-in-an-ADR discipline, repo rule 3); no `scripts/*-verify.mjs` is
  added.
- **The LEDGER line is corrected, not deleted.** The prior "awaits its consumer-driven ADR"
  framing is replaced by the measured outcome: the driver exists, measured the motivating
  blind spot away, and shipped no panic hook; the patch is withdrawn for no-demand and is
  reversible if a future consumer ADR wants a panic instrumentation point, citing this ADR.
- **The reopen condition is explicit and narrow.** Reopen patch #5 only if a consumer ADR asks
  for a panic-time instrumentation point, for example a standalone-reproducible crash the reset
  reason genuinely cannot classify (`adversary:ADR-0136`'s named condition, which that ADR would
  itself route to a flash core dump rather than a hook). Because `esp_system` is source-
  available, that patch would be a straight source hook, not a blob problem. No such consumer
  exists today.
- **The consumer keeps its reset-reason classifier.** `adversary:ADR-0136` and the existing
  `classifyReset` + fail-loud-on-unmapped guard are unaffected; they never depended on this
  repo. Nothing in that firmware changes because of this decision.
- ADR-0001 is not superseded: its fork model, tracking policy, release shape, and invariants
  stand. This ADR corrects the last bullet of its roadmap with measured evidence, exactly as
  ADR-0019, ADR-0023 and ADR-0024 did for patches #1, #3 and #4.
