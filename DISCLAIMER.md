# DISCLAIMER

## What this project is

esp32-arduino-adv-libs is **build tooling**. It produces precompiled ESP-IDF +
Arduino-core libraries that two sibling firmwares (`adversary` and
`esp32-wifi-sapper`) consume. It is not itself an attack tool: it attacks
nothing and connects to no network. It does, however, exist to serve
authorized-pentest firmware, so the same ground rules apply to what it feeds.

## Educational and research purposes only

The artifacts this project builds are intended for security professionals and
researchers doing authorized, lawful work: penetration testing with permission,
education, and defensive research. Use the downstream firmware only on networks
and devices you own or have explicit, written permission to test.

## No warranty

This software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability, fitness
for a particular purpose, and non-infringement. In no event shall the authors or
copyright holders be liable for any claim, damages, or other liability, whether
in an action of contract, tort, or otherwise, arising from, out of, or in
connection with the software or the use or other dealings in the software. The
released libraries are built from upstream sources (ESP-IDF, Arduino-core) and
carry their respective upstream licenses and warranties; see the README.

## Alpha status

This project is in **alpha**. The pipeline, pins, and release shape may change,
and a release may be rebuilt or withdrawn. Pin a specific release and verify its
recorded provenance (the five-pin manifest and the published SHA-256) before you
depend on it.

---
*By building, downloading, or consuming a release of this project, you acknowledge
that you have read and understood this disclaimer.*
