---
id: '0007'
title: "Bump the builder's forced C++ standard to C++20 for the pinned arduino master base"
type: architecture
status: accepted
date: 2026-11-13
supersedes: []
superseded_by: []
---

## Context

With the source pins corrected (ADR-0005), esp_matter removed (ADR-0006), and the C++ standard still
untouched, run `43508482754` (commit `66cf3f8`) got deep into the real compile and failed on **both**
chips, at different files but with the identical error class:

```
# esp32, arduino-esp32 HTTPClient.cpp:1247
_currentHeaders.emplace_back(headerName, headerValue);
  error: no matching function for call to 'HTTPClient::RequestArgument::RequestArgument(String&, String&)'

# esp32s3, espressif__esp-dl dl_image_bmp.cpp:163
img_t img_cvt(data, img.width, img.height, DL_IMAGE_PIX_TYPE_BGR888);
  error: no matching function for call to 'dl::image::img_s::img_s(void*&, const uint16_t&, const uint16_t&, pix_type_t)'
```

Both `RequestArgument` (`struct { String key; String value; }`) and `img_s` are braceless aggregates
with no user-declared constructors. Constructing one through `emplace_back(a, b)` / a parenthesized
argument list calls a constructor, which an aggregate does not have, **unless** the standard is C++20
or later: P0960 ("Allow initializing aggregates from a parenthesized list of values") makes the
compiler synthesize that call for aggregates, and it lands only in C++20. Under C++17 both are
hard errors. esp32 dies in `HTTPClient`; esp32s3 dies earlier in `esp-dl` (esp32 does not build
`esp-dl`), so the two chips surface the same defect in different files.

The compile commands on both chips carry `-std=gnu++2b` (IDF 5.5's own default) followed by
`-std=gnu++17`, and the last `-std` wins, so the whole project, IDF core included, compiles as C++17.
IDF core is C++17-clean, so only the newer aggregate-using code breaks. The trailing flag comes from
the builder's root `CMakeLists.txt` (measured at pin `e68e301`):

```cmake
idf_build_set_property(CXX_COMPILE_OPTIONS "-std=gnu++17;-DCHIP_HAVE_CONFIG_H" APPEND)
```

This is the same divergence class as ADR-0005 and ADR-0006, one layer deeper: we pin arduino-esp32 to
a **master-base** commit (`9b3364c6`, 2025-12-04) that is newer than the stale `idf-release_v5.5`
builder branch tracks, and that arduino (and the `esp-dl` it pulls on esp32s3) now requires C++20. The
reference blob built the byte-identical arduino source because bruce's builder fork was not pinned to
C++17. Espressif's own builder has already resolved this the same way: the `master` branch of
`esp32-arduino-lib-builder` carries `-std=gnu++2a` on that exact line, where `idf-release_v5.5` still
carries `-std=gnu++17` (measured 2026-11-13).

## Decision

Overlay-rewrite the cloned builder's root `CMakeLists.txt`, changing the forced standard from
`-std=gnu++17` to `-std=gnu++2a`, matching what espressif set on the builder's master branch.
`UPSTREAM.lock` carries `builderCxxStandard: { from, to }`; `applyOverlay` calls
`setBuilderCxxStandard`, a pure function that replaces the `from` flag and fails loud if it is absent
(an upstream edit to this line must break the build visibly, not silently no-op the fix). The pin is
mandatory for this build, not optional: `cmdChip` throws if `builderCxxStandard` is missing, the same
way it already does for `sourcePins.idfCommit`, so a dropped key cannot let the build fall back to
gnu++17 and fail deep in the compile; and `setBuilderCxxStandard` rejects a malformed `{from}`-only
pin rather than writing `-std=undefined`.

`gnu++2a` (C++20), not `gnu++2b` (C++23), because:

- C++20 is sufficient: P0960 aggregate paren-init, the one feature both failures need, is a C++20
  feature. `gnu++2b` would claim a newer standard than the fix requires.
- It matches the exact value espressif chose on their builder master for this same newer-arduino
  situation. Tracking their decision keeps the overlay a thin follow of upstream, not an independent
  guess at the right standard.

This is a new decision, not a supersession. It completes the ADR-0005 pins: pinning arduino to a
master base is only coherent if the build compiles that base at the standard it was written for.
ADR-0001's stock-builder choice stands; this is another instance of the ADR-0006 principle (adopt the
minimal upstream-blessed config change rather than Bruce's whole fork config).

## Consequences

- Both chips compile their aggregate-using code. This is the last config-divergence blocker found
  before the build either completes or reveals a genuinely new failure further in.
- The entire project, IDF core included, now builds as C++20 instead of C++17. This is what IDF 5.5's
  own `-std=gnu++2b` default already intended before the builder overrode it, and what espressif's
  builder master now does, so it widens rather than narrows the standard: C++17-valid code stays valid
  under C++20. It is not a per-component change; a future component that is not C++20-clean would be a
  new, separate finding.
- The `-DCHIP_HAVE_CONFIG_H` define on the same line is now orphaned (it is a Matter/CHIP define, and
  esp_matter was removed in ADR-0006). It is harmless (a define nothing reads) and left in place to
  keep this change one concern; it is tracked in `LEDGER.md` with the other orphaned Matter config.
- `setBuilderCxxStandard` is a builder-config overlay, the same class as `removeManagedComponents` and
  the version/source pins, not a numbered `patches/` entry: the patch stack is reserved for
  consumer-driven IDF/arduino source patches (standing invariants 1-2), and this touches builder
  config only.
