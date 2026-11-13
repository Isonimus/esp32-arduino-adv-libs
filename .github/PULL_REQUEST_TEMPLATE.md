## Summary

<!-- What does this change do, and why? Explain the reasoning, not just the diff. -->

Closes #

## Type of change

- [ ] Patch stack change (new or modified `patches/*.patch`)
- [ ] Build / release pipeline (`scripts/`, workflows, `UPSTREAM.lock`)
- [ ] Documentation / decision record (`adr/`, `slices/`, README)
- [ ] Bug fix
- [ ] Other

## Checks

<!-- Paste relevant output if useful. -->

- [ ] `npm run lint` passes
- [ ] `npm run index:check` passes
- [ ] `npm test` passes

## If this touches the patch stack

- [ ] One concern per patch
- [ ] Each patch header cites its consuming ADR (`adversary:ADR-NNNN` or
      `esp32-wifi-sapper:ADR-NNNN`) with a short rationale
- [ ] Source patch only, no post-build binary rewrite

## Checklist

- [ ] Follows the standards in [CLAUDE.md](../CLAUDE.md) and
      [docs/quality-bar.md](../docs/quality-bar.md)
- [ ] Added or updated tests for any changed logic
- [ ] Conventional-commit messages, one logical change per commit, no attribution trailers
- [ ] This change is for authorized, lawful use (see [DISCLAIMER](../DISCLAIMER.md))
