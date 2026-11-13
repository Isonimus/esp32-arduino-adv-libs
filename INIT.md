# esp32-adv-libs

Initial specification for the assistant. This document is the brief: read it end-to-end
before touching anything. When the first substantive work begins, this file is retired
and its content moves into `README.md`, `CLAUDE.md`, the first ADRs, and `LEDGER.md` as
appropriate (stele:ADR-0001 single-writer rule).

---

## Mission

Own a **patched ESP-IDF + Arduino-core precompiled libs build** that two sibling
authorized-pentest firmwares consume in place of the third-party precompiled blob they
pull today. Produce release artifacts shaped like
`framework-arduinoespressif32-libs` so `platformio.ini` across the two consumers can be
re-pointed with a one-line URL swap.

The two consumers, both on-disk siblings under `~/local_repo/`:

| Repo | Role | Hardware today |
|---|---|---|
| `adversary` | Red-team wireless pentesting firmware (M5Stack Cardputer + M5StickC Plus2) | ESP32-S3 (Cardputer), ESP32-PICO (Stick) |
| `esp32-wifi-sapper` | Headless/UI-light WiFi handshake hunter, portable across multiple boards | ESP32-S3 + classic ESP32, PSRAM and no-PSRAM variants |

Both currently pin the same precompiled blob:
`framework-arduinoespressif32-libs @ https://github.com/bmorcelli/esp32-arduino-lib-builder/releases/download/idf-release_v5.5/bruce_esp32-arduino-libs-20251205-131242.zip`

That blob is a fork of the upstream `espressif/esp32-arduino-lib-builder` maintained by
the Bruce project (another red-team firmware on the same hardware class). We are
retiring our dependency on it.

---

## Why this repo exists: four payoffs, three measured costs already paid

The initiative was decided in the siblings' ledgers on 2026-10-27 after shipping
`esp32-wifi-sapper:ADR-0080`, and has accumulated three concrete pieces of evidence since.

### Payoffs

1. **Set sdkconfig flags the precompiled blob fixes shut.** Measured 2026-10-27 while
   shipping `esp32-wifi-sapper:ADR-0080`: `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY` is
   **unset** in the Bruce libs, so static `EXT_RAM_BSS_ATTR` PSRAM placement cannot link.
   The Sapper had to work around with runtime `heap_caps_malloc` (`CONFIG_SPIRAM_USE_MALLOC=y`
   is on). Owning the build lets us flip that flag and supersede ADR-0080 with the simpler
   static-attribute form.
2. **Bake the raw-deauth-TX patch into the libs.** The Adversary currently layers a
   PlatformIO pre-build hook (`scripts/weaken_deauth_pre.py` + `scripts/weaken_deauth_symbol.sh`)
   that runs `objcopy --weaken-symbol=ieee80211_raw_frame_sanity_check` on
   `libnet80211.a` before each build so the override in `src/modules/attack/deauth.cpp`
   links cleanly. A framework-libs reinstall silently restores strong linkage and breaks
   the link. Baking weak-by-construction into the shipped libs retires the hook in both
   repos. The Sapper ledger line references `scripts/weaken_deauth_pre.py` (`ADR-0027`,
   `ADR-0029`).
3. **Auditable RF-stack provenance for a red-team appliance.** Both firmwares are
   authorized-pentest tools, so the RF stack they ship must be auditable end to end. A
   third-party precompiled blob from a maintainer's release pipeline is the weakest link
   in that chain; a build we drive from source over a pinned IDF + Arduino-core + applied
   patch set + published build logs + checksums is the strongest practical replacement.
4. **Control over opaque internals that have already cost us three times.** Each entry
   below is an ADR that landed in the last two weeks whose workaround exists only because
   we do not own the libs.
   - **Inert Arduino custom-panic hook** (`adversary:ADR-0135`, `adversary:ADR-0136`,
     2026-11-01). The Arduino core's `--wrap` of `esp_panic_handler` never intercepts the
     real symbol, because inside the precompiled archive the panic path is reached
     directly without going through the wrapped entry. Panic-time instrumentation is
     therefore impossible on the precompiled build. ADR-0135 introduced an RTC-flag probe
     to work around; ADR-0136 dropped it after measuring that the symptom was a tethered
     host artifact. An owned build can either expose a real panic hook or ensure the wrap
     chain holds.
   - **No raw EAPOL-M1 / PMKID path in wpa_supplicant** (`adversary:ADR-0137`,
     2026-11-03). The precompiled `wpa_supplicant` exposes no API for a managed-association
     route to clientless PMKID. The Adversary therefore uses frame injection; the owned
     build can re-wrap the supplicant or expose the missing path.
   - **IDF 5.5 scan API drops PMF bits** (`adversary:ADR-0153`, 2026-11-13).
     `wifi_ap_record_t` carries no PMF fields and the IDF discards the beacon RSN IE
     buffer after the record is built. Reading an AP's advertised `MFPC`/`MFPR` bits
     therefore requires a secondary promiscuous-beacon pass + a hand-rolled RSN IE parser
     sitting on top of `WiFi.scanNetworks()`. Slice-0154 in the Adversary shipped exactly
     that workaround (`parseRsnPmfBits` + 120 ms/channel beacon sniff). An owned build can
     attach the two bits to `wifi_ap_record_t` directly and retire the sniff pass.

### Costs

`esp32-arduino-lib-builder` is a heavy Docker toolchain: multi-GB base image, hour-plus
build per chip, two chips today (esp32, esp32s3), more later. It is an upgrade treadmill
(re-apply the patch set per IDF / Arduino-core bump). It is a third repo with its own
method (CLAUDE.md, LEDGER.md, lint, CI) to maintain.

The initiative was deferred until a concrete payoff pile accumulated. It has.

---

## Scope

### In scope

- Fork `espressif/esp32-arduino-lib-builder` (upstream, not Bruce's fork) at the IDF
  release the consumers currently track (`idf-release_v5.5` or its successor at kickoff
  time).
- Maintain an ordered **patch stack** against that IDF + Arduino-core, one patch per
  concern, each with a reasoned header citing the consuming ADR.
- Produce **release artifacts** shaped like the Bruce release the consumers currently
  pull: one zip per IDF tag + patch-stack rev, named and laid out so a single-line
  change in each consumer's `platformio.ini` rebinds it.
- Target chip set: **`esp32` and `esp32s3`** at minimum (both consumers today). The
  classic `esp32` is needed for the Sapper's CYD / T-embed / M5StickC Plus2 legs; `esp32s3`
  is needed for the Adversary's Cardputer and the Sapper's first-PSRAM boards.
- **CI**: on tag, build all targeted chips, publish a GitHub Release with the zip +
  SHA-256 attestation + a reproducible build manifest (IDF commit, Arduino-core commit,
  patch stack content hash, docker image digest).

### Out of scope

- Hosting or forking the consumers' firmwares. This repo only ships libs.
- Third-party C++ libraries the consumers pull via `lib_deps` (ArduinoJson, M5GFX, LovyanGFX,
  etc.). Those stay where they are.
- 5 GHz / Zigbee / 802.15.4 / LoRa chip builds (future, gated on a consumer actually
  needing them; today both consumers are 2.4 GHz WiFi + BLE classic/LE + SubGHz via an
  external CC1101).
- Reproducing a specific competitor's feature set (Bruce, Marauder). This repo tracks
  the two consumers' needs only.

---

## The initial patch stack

The first release must carry **at minimum** patches #1 and #2 below; both consumers
link today only because of the objcopy post-hook, and both will swap to the owned
build atomically on a single `platformio.ini` URL change, so weak-deauth cannot be
absent. Patches #3-#5 land in subsequent releases as each is designed and verified.

| # | Name | What it does | Consuming ADR | Retires (consumer side) |
|---|---|---|---|---|
| 1 | `weak-ieee80211_raw_frame_sanity_check` | Declare the symbol `__attribute__((weak))` in the IDF source so `libnet80211.a` ships weak, the override in `deauth.cpp` links cleanly, and no post-fetch objcopy is required. | `adversary:ADR-0027`, `adversary:ADR-0029` | `scripts/weaken_deauth_pre.py` + `scripts/weaken_deauth_symbol.sh` |
| 2 | `sdkconfig-spiram-bss-ext` | Set `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` in the shipped sdkconfig so `EXT_RAM_BSS_ATTR` placements link on PSRAM boards. | `esp32-wifi-sapper:ADR-0080` | the runtime `heap_caps_malloc` manifest placement (supersession path) |
| 3 | `wifi_ap_record-pmf-bits` | Add `pmf_capable` and `pmf_required` fields to `wifi_ap_record_t` (end of struct, feature-gated), populate them from the beacon RSN IE during scan processing before the IE buffer is freed. | `adversary:ADR-0153` | the beacon-sniff pass + `parseRsnPmfBits` in `adversary` (slice-0154) |
| 4 | `supplicant-pmkid-path` | Expose or re-wrap a supplicant entry point that lets the firmware drive a clientless PMKID solicitation through the managed-association path. Size and shape to be designed by its own consumer ADR. | `adversary:ADR-0137` | the frame-injection PMKID path in `adversary` |
| 5 | `panic-hook-wrap-chain` | Either repair the `--wrap(esp_panic_handler)` chain inside the archive so the Arduino core's weak panic hook takes effect, or expose a dedicated panic-callback hook the firmware can register. | `adversary:ADR-0135`, `adversary:ADR-0136` | the (already-retired) RTC-flag probe; forward-enables panic-time instrumentation |

Each patch is a reasoned change to the IDF or Arduino-core tree, not a post-build
rewrite. Post-build rewrites were the problem; this repo is the solution to it.

---

## Hard constraints

Inherited from the parent repos (stele:ADR-0001 global working conventions, plus
`adversary/CLAUDE.md` and `esp32-wifi-sapper/CLAUDE.md`):

- **No `Co-Authored-By`, no "Generated with Claude Code", no attribution trailers** in
  commit messages, PR bodies, issue comments, or any other VCS surface. Plain
  conventional messages only.
- **No em dashes** in any prose: commits, docs, comments, PR bodies, user-facing copy.
  Colons, commas, semicolons, parentheses, or a rephrase instead. Does not apply to text
  being quoted from an existing file.
- **Commit only when asked.** Never commit unprompted.
- **Never hardcode absolute paths** in config files, scripts, or commands: always
  relative.
- **English only** across code, comments, commits, docs.
- **Pushing is an outward action**: get the go-ahead first.
- **Design first**: the decision is written down before the code, and the two ship in
  the same commit (ADR beside slice beside implementation).
- **Fail loud**: no swallowed errors, no catch-log-and-continue past a broken invariant,
  no default that masks a real failure. Validate at boundaries, stop at the first sign.

### Repo-specific constraints

- **Reproducible builds.** Each release must be reconstructable from the committed
  patch stack + pinned IDF commit + pinned Arduino-core commit + pinned Docker image
  digest. The release manifest records all four. A release that cannot be rebuilt
  bit-for-bit is a release with no provenance guarantee and defeats payoff #3.
- **One concern per patch.** Patches are review-shaped, not commit-shaped. Combining
  patches #1 and #2 into one blob is a refusal to answer "which change broke the link";
  do not do it.
- **Patch headers cite the consuming ADR.** `adversary:ADR-NNNN` or
  `esp32-wifi-sapper:ADR-NNNN` as applicable. The linter cannot resolve cross-repo
  citations (stele:ADR-0009) but the convention is kept so a reviewer can.
- **No strong `any`-equivalent escape in build glue.** Python/bash build scripts have no
  type system to abuse, but the equivalent (swallowed `|| true`, broad `except:`,
  silenced `set +e`) is forbidden for the same reason.
- **Consumer parity.** A release that compiles only on `esp32s3` ships nobody. Every
  tagged release builds and publishes all enabled chips; a per-chip build failure
  fails the whole release.

---

## Build pipeline (expected shape, open to redesign)

The upstream `esp32-arduino-lib-builder` is already a shell + python toolchain that
drives IDF's build inside a Docker image and produces the final artifact. Starting
point: fork it, do not rewrite it. The patches we care about are applied as a thin
layer on top.

```
.
├── patches/                     # ordered, each a single reasoned diff + rationale
│   ├── 0001-weak-ieee80211_raw_frame_sanity_check.patch
│   ├── 0002-sdkconfig-spiram-bss-ext.patch
│   └── ...
├── sdkconfig/                   # overlay files per board / per feature class
├── scripts/                     # fork from upstream, modify minimally
├── .github/workflows/
│   └── release.yml              # matrix: {esp32, esp32s3} -> zip + attestation
├── CLAUDE.md                    # method
├── LEDGER.md                    # open work, deferrals, defects (stele:ADR-0001)
├── README.md                    # how to consume (URLs, pins, provenance)
├── CHANGELOG.md                 # user-facing per release
├── adr/                         # architecture decision records
└── INIT.md                      # this file (deleted after v0.1.0)
```

### Release naming

`adv-esp32-arduino-libs-<IDF_TAG>-<YYYYMMDD>-<SHORTSHA>.zip`, one per chip inside the
zip at the same layout the consumers already expect
(`framework-arduinoespressif32-libs/<chip>/...`). The zip URL goes into both consumers'
`platformio.ini` lines.

### CI gates

- On push to a `patches/` or `sdkconfig/` or `scripts/` path: rebuild all chips, fail
  on any chip failing. No artifact published on push.
- On tag `v*`: rebuild all chips, publish GitHub Release with zip + SHA-256 + build
  manifest (IDF commit, Arduino-core commit, patch-stack content hash, Docker image
  digest).
- Reproducibility check: tag-rebuild compares byte-for-byte against the previous build
  of the same tag; divergence fails the release.

---

## Integration path for the two consumers

The release is not integrated incrementally; it is integrated **atomically** per
consumer, one-line `platformio.ini` change, because the lib URL is monolithic.

### Adversary

1. On the first release carrying patches #1 and #2, swap both `platformio.ini` lines
   (`[env:cardputer]` and `[env:m5stick]`) to the new URL.
2. Retire `scripts/weaken_deauth_pre.py` and `scripts/weaken_deauth_symbol.sh`,
   including the `extra_scripts` entries that invoke them.
3. Build serially (`pio run -e cardputer -j 2` then `pio run -e m5stick -j 2`, per
   `adversary/CLAUDE.md` build-parallelism rule), confirm link, flash, smoke-test
   deauth on a lab AP.
4. Mark the parallel work items on the Adversary ledger as closed (ledger line 46 half,
   plus the per-blind-spot entries that get retired as their patches land).

### Sapper

1. Swap the six `platformio.ini` lines (one per env) to the new URL in one commit.
2. On the release carrying patch #2, supersede ADR-0080's runtime manifest placement
   with the static `EXT_RAM_BSS_ATTR` form; this is the planned ADR-0080 supersession
   path and lands as its own ADR in the Sapper.
3. Retire the Sapper's mirror ledger line.

Both consumers' `platformio.ini` lines are a single pinned URL today, which keeps the
cutover simple: one commit per repo.

---

## First milestones

In order; each is its own ADR + slice in this repo.

1. **ADR-0001**: fork point, upstream tracking policy, patch-stack conventions, release
   artifact shape. Ship it before any Dockerfile exists.
2. **slice-0001**: fork `espressif/esp32-arduino-lib-builder` at `idf-release_v5.5`, add
   the method files (`CLAUDE.md`, `LEDGER.md`, `README.md`, lint, index), produce an
   unmodified `v0.0.1` zip identical in shape to the consumers' current input, build
   both chips, publish the release. **No patches yet.** This proves the pipeline and
   the drop-in replaceability before the patch stack is introduced.
3. **slice-0002**: patch #1 (`weak-ieee80211_raw_frame_sanity_check`). Ship `v0.1.0`.
   On the Adversary side, swap `platformio.ini` and retire the objcopy hook in the
   same PR. Verify deauth on a lab AP.
4. **slice-0003**: patch #2 (`sdkconfig-spiram-bss-ext`). Ship `v0.2.0`. On the Sapper
   side, land ADR-0080 supersession in the same PR. Verify static PSRAM placement on a
   first-PSRAM board.
5. **slice-0004**: patch #3 (`wifi_ap_record-pmf-bits`). Ship `v0.3.0`. On the
   Adversary side, retire the beacon-sniff pass from slice-0154 and swap to the new
   field in one PR.
6. Patches #4 and #5 follow when their consumer ADRs are ready to drive them.

---

## References

### Cross-repo ledger lines (mirrored pair, kept in sync by convention)

- `adversary/LEDGER.md` line 46 (the richer one: lists the three blind spots paid for).
- `esp32-wifi-sapper/LEDGER.md` line 79 (lists the explicit ADR-0080 supersession path).

Both close when the corresponding payoff is delivered by a release here. Partial
delivery deletes the relevant sub-clause, not the whole line; a line deletes only when
the last unresolved clause does.

### ADRs cited above

- `adversary:ADR-0027`, `adversary:ADR-0029` — raw-deauth link hook
- `esp32-wifi-sapper:ADR-0080` — runtime `heap_caps_malloc` PSRAM placement (to be
  superseded)
- `adversary:ADR-0135`, `adversary:ADR-0136` — inert panic hook probe + its retirement
- `adversary:ADR-0137` — clientless PMKID via injected association (frame-injection
  path, taken because supplicant exposes no managed-association route)
- `adversary:ADR-0153` — PMF-aware attack selection (shipped slice-0154's beacon-sniff
  workaround)

### Upstream

- `espressif/esp32-arduino-lib-builder` — the IDF + Arduino-core builder we fork.
- `bmorcelli/esp32-arduino-lib-builder` — Bruce's fork, the current precompiled source
  we are retiring (not forked from; consulted only for the shape of the shipped zip).

---

## What the assistant does on its first turn

Do **not** start writing Dockerfiles or patches. Start by:

1. Reading this file in full.
2. Reading the two consuming CLAUDE.md files (`~/local_repo/adversary/CLAUDE.md`,
   `~/local_repo/esp32-wifi-sapper/CLAUDE.md`) so the method lineage is clear.
3. Running the `init-method` skill to install the stele method here (CLAUDE.md,
   LEDGER.md, linter, index, pre-commit hook). This is a one-shot setup; skip if the
   repo already has them.
4. Writing ADR-0001 per milestone 1 above, pausing for review before starting slice-0001.

The first thing committed to this repo is the method + ADR-0001, together, as that
ADR is the first substantive decision. The fork-and-build work follows as slice-0001.
