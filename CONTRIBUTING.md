# Contributing to esp32-arduino-adv-libs

Thanks for your interest. This repo is small and opinionated; a few things make a
contribution land smoothly.

## Before anything: authorized use only

This project builds the precompiled libraries that red-team firmware consumes. By
contributing you accept that it exists for **authorized testing, education, and
research** only (the terms in the [DISCLAIMER](DISCLAIMER.md)). Contributions whose
only purpose is to harm third parties, evade the law, or target people without
consent will be declined.

## What this repo is

A **thin overlay** over `espressif/esp32-arduino-lib-builder`. It holds only our
delta: an ordered patch stack, an optional sdkconfig overlay, build orchestration,
and CI. The heavy build is upstream's, cloned at the commit pinned in
`UPSTREAM.lock` and run in a digest-pinned Docker image. The *why* lives in
[`adr/0001-fork-model-tracking-patch-conventions-release-shape.md`](adr/0001-fork-model-tracking-patch-conventions-release-shape.md);
the *how* lives in [`README.md`](README.md).

## Development setup

Requires Node.js 20+, git, tar, and zip. Docker is needed only for a full
image/chip build; the packaging and all the checks run without it.

```bash
npm run lint         # zero-dependency doc linter (the stele method)
npm run index:check  # adr/INDEX.md matches the corpus
npm test             # node:test suite for the build helpers
```

There are **no npm dependencies**; the scripts are plain Node. An IDF build is
multi-GB and roughly an hour per chip, so it runs in CI (`.github/workflows/release.yml`),
not usually on a laptop. See the README for the local build commands.

## Adding a patch

The patch stack is the heart of this project, and it has hard rules (ADR-0001):

- **One concern per patch.** Combining two concerns into one patch is forbidden:
  it refuses to answer "which change broke the link".
- **Each patch cites its consuming ADR.** A patch exists because a consumer needs
  it; its header carries the reference (`adversary:ADR-NNNN` or
  `esp32-wifi-sapper:ADR-NNNN`) and a short rationale.
- **Source patches only.** A correction is a change to source, never a post-build
  binary rewrite.

Patches are numbered `git format-patch` diffs under `patches/`. The build applies
them in filename order and the manifest records the stack's content hash.

## The decision records

`adr/` and `slices/` are the project's **decision records** (an ADR/slice workflow,
the "stele" method). ADRs and slices are immutable once written; open work lives in
the single `LEDGER.md`. A pre-commit hook runs the linter and checks the generated
index and the immutability rule. Read [`CLAUDE.md`](CLAUDE.md) and
[`docs/quality-bar.md`](docs/quality-bar.md) before a non-trivial change: the
engineering bar there applies to everyone, not just AI-assisted work.

## Commits and pull requests

- **Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`, with an optional scope. One logical change per commit.
- Explain **why** in the body, not just what. No attribution or generated-by
  trailers.
- Fork, branch (`feature/...` or `fix/...`), open a PR against `main`.
- Fill in the PR template, and make sure `npm run lint`, `npm run index:check`,
  and `npm test` pass locally first. CI runs the same on every push and PR.

## Reporting bugs and requesting features

Use the issue templates. For anything security-sensitive in the build or release
pipeline, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
