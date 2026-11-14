#!/usr/bin/env python3
# In-container remover for managed components arduino-esp32 declares in its own idf_component.yml
# (slice-0012, ADR-0011). It is a faithful port of removeManagedComponents in scripts/build.mjs:
# line-based removal of a component's whole indented block, failing loud if a named component is
# absent so a stale removal cannot silently no-op.
#
# WHY python, not the JS remover: arduino-esp32's manifest only exists inside the build container
# (build.sh clones arduino, then the overlay force-checks it out to arduinoCommit), so the edit must
# run in-container. The builder image (tools/docker/Dockerfile, ubuntu:22.04) installs python3 but no
# node, so the JS implementation cannot run there. The two removers in two languages is the accepted
# cost of the arduino tree being reachable only in-container (ADR-0011). No PyYAML: a line-based block
# delete preserves every other line byte-for-byte, where a YAML round-trip would reformat the file.
#
#   python3 strip-manifest-components.py <manifest.yml> <component> [<component> ...]

import re
import sys


def strip_components(text, names):
    lines = text.split("\n")
    for component in names:
        key_re = re.compile(r"^(\s+)" + re.escape(component) + r":\s*$")
        key_idx = -1
        key_indent = ""
        for i, line in enumerate(lines):
            m = key_re.match(line)
            if m:
                key_idx = i
                key_indent = m.group(1)
                break
        if key_idx == -1:
            raise SystemExit(
                'strip-manifest-components: component "%s" not found in manifest' % component
            )
        # First line past this component's block: the next non-blank line indented no deeper than the
        # key. Blank lines belong to the block until a shallower key (matches removeManagedComponents).
        end = key_idx + 1
        while end < len(lines):
            if lines[end].strip() == "":
                end += 1
                continue
            indent = re.match(r"^(\s*)", lines[end]).group(1)
            if len(indent) <= len(key_indent):
                break
            end += 1
        del lines[key_idx:end]
    return "\n".join(lines)


def main(argv):
    if len(argv) < 3:
        raise SystemExit(
            "usage: strip-manifest-components.py <manifest.yml> <component> [<component> ...]"
        )
    manifest_path = argv[1]
    names = argv[2:]
    # newline="" keeps line endings byte-for-byte (no universal-newline CRLF->LF rewrite), so this
    # remover and the JS removeManagedComponents produce identical output on any input (ADR-0011).
    with open(manifest_path, "r", encoding="utf-8", newline="") as f:
        text = f.read()
    stripped = strip_components(text, names)
    with open(manifest_path, "w", encoding="utf-8", newline="") as f:
        f.write(stripped)
    print(
        "strip-manifest-components: removed %d component(s) from %s: %s"
        % (len(names), manifest_path, ", ".join(names))
    )


if __name__ == "__main__":
    main(sys.argv)
