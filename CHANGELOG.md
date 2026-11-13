# Changelog

Notable changes, newest first. This is a **hand-maintained** record. When the
project settles into tag-based releases, it can be replaced by a git-tag-generated
changelog.

---

## Unreleased

Repo bootstrap. No release has been tagged yet; `v0.0.1` will be the first.

- **Thin-overlay builder fork established.** The repo owns a patched ESP-IDF 5.5 +
  Arduino-core precompiled-libs build as a thin overlay over
  `espressif/esp32-arduino-lib-builder`, pinned at commit `e68e301` (ADR-0001). It
  holds only our delta; the heavy build is upstream's, run in a digest-pinned
  Docker image in CI.
- **slice-0002 overlay landed, unproven.** `UPSTREAM.lock` (five-pin inputs),
  `scripts/build.mjs` (image/chip/package), `.github/workflows/release.yml` (the
  matrix gate), and `scripts/0002-verify.mjs` (drop-in shape parity against the
  measured Bruce-blob layout). No patches are applied: `v0.0.1` is the unmodified
  baseline the patch stack later builds on.
- **Doc method and quality bar vendored.** The stele method (immutable ADRs and
  slices, one mutable `LEDGER.md`, a zero-dependency linter, index builder, and
  pre-commit hook) and a `node:test` suite guarding the build helpers.
- **Repo infrastructure added.** License, code of conduct, contributing and
  security policies, issue and PR templates, Dependabot, a lint/test CI workflow,
  and CodeQL scanning.
- **ADR-index cell escaping hardened.** `scripts/build-index.mjs` now escapes the
  backslash before the pipe, so a title carrying either character cannot corrupt
  the generated table (CWE-116, first CodeQL finding); covered by a regression test.
- **IDF version now selected explicitly (ADR-0003).** The first heavy CI build
  revealed the upstream builder defaults to ESP-IDF `release/v5.3`, so the overlay
  was silently building 5.3, not the 5.5 the consumers need. `UPSTREAM.lock` gains
  `upstream.idfBranch` (`release/v5.5`), passed to `build.sh -I`; the build fails
  loud if it is absent. Also fixed the container `safe.directory` so in-container
  git works on the runner-owned mount.

The CI build and the `v0.0.1` tag are intentionally unproven at bootstrap:
standing invariants 4 and 5 stay pending in `LEDGER.md` until a tagged build is
green.
