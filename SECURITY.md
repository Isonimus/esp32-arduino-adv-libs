# Security Policy

## What counts as a security issue here

esp32-arduino-adv-libs is a **supply-chain component**: it builds the precompiled
ESP-IDF + Arduino-core libraries that the `adversary` and `esp32-wifi-sapper`
firmwares pull into their builds. The whole point of this repo is provenance, so
a reportable security issue is a defect that lets a **tampered or un-provenanced
artifact be consumed as if it were trusted**, or that weakens the guarantees a
release claims. For example:

- The five-pin manifest or the shape/provenance check (`scripts/0002-verify.mjs`)
  being bypassable, so a release can publish without its recorded pins actually
  matching what shipped.
- The patch-stack content hash or the Dockerfile `FROM`-pin being forgeable or
  mis-computed, so the attested patch set or builder image is not what was
  actually built.
- A build that silently drops an enabled chip yet still publishes a release
  (the all-chips-or-fail invariant being circumvented).
- Pin resolution following an attacker-influenced ref or digest instead of the
  one recorded in `UPSTREAM.lock`.
- Any defect in the build or release scripts that would let arbitrary content
  reach a consumer under this project's name.

Please do **not** report the fact that the produced libraries are consumed by
offensive-security firmware: that is the intended purpose, governed by the
[DISCLAIMER](DISCLAIMER.md), not a vulnerability. Vulnerabilities **inside** the
consuming firmware belong in that firmware's own repository, not here.

## Supported versions

The project is in **alpha**. Only the latest `main` and the most recent release
are supported; fixes land on `main`.

| Version            | Supported |
| ------------------ | --------- |
| latest `main`      | ✅        |
| latest release tag | ✅        |
| older tags/commits | ❌        |

## Reporting a vulnerability

Report privately, not in a public issue:

1. **Preferred:** GitHub private vulnerability reporting, via this repository's
   **Security → Advisories → Report a vulnerability** tab.
2. Otherwise, contact the maintainer [@Isonimus](https://github.com/Isonimus).

Please include the affected release tag or commit, the affected part of the
pipeline (a build script, the verify step, the workflow, a pin), reproduction
steps, and the impact (what untrusted content could reach a consumer, or which
provenance guarantee is defeated). There is no bug-bounty program, this is a
research project, but reports are welcome and will be credited if you would like.
