# Third-party notices

- **OBS Studio / libobs** — GPL 2.0 or later. The optional Windows development streaming helper links libobs and selected OBS plugins; its source has the same license designation. The development payload includes OBS's COPYING and the helper/build-script source. Distributing it requires the full applicable dependency notices and corresponding source/build materials for the exact binaries; the experimental payload is not yet included in release packages. [OBS source](https://github.com/obsproject/obs-studio). See [native sharing development](docs/helltube-embed.md).

- **Mumble** — BSD 3-Clause, The Mumble Developers. The native engine is built from the supplied source checkout. Its full license is copied to voice/MUMBLE-LICENSE. [Source](https://github.com/mumble-voip/mumble).
- **RNNoise** — BSD 3-Clause, Jean-Marc Valin and contributors. The full license is copied to voice/RNNOISE-LICENSE. [Source](https://github.com/xiph/rnnoise).
- **PhotinoX / PhotinoX.Native 5.3.0** — Apache 2.0. [Managed source](https://github.com/ivanvoyager/PhotinoX), [native source](https://github.com/ivanvoyager/PhotinoX.Native).
- **Velopack 1.2.161** — MIT, Caelan Sayler and Velopack Ltd. Used for Windows per-user installation and update replacement. [Pinned source](https://github.com/velopack/velopack/tree/1.2.161); full license in [docs/velopack-license.txt](docs/velopack-license.txt).
- **Qt 6** — the native build uses the installed static Qt libraries. Qt modules have their own LGPL/GPL/commercial licensing terms. Before distributing native binaries, include the applicable notices and satisfy the license for the Qt build you use, including any relinking/source requirements.
- **Other Mumble dependencies**, including Opus, SpeexDSP, OpenSSL, Protobuf, Boost, and libsndfile, retain their own licenses. Mumble's About/license UI and upstream 3rdPartyLicenses contain notices; the build preparation copies these notices alongside the engine.
- **Helltube** runs from the user's existing deployment. Its sources/assets are not copied into Strife.

Release packages include upstream notices and the dependency copyright files supplied by the pinned vcpkg toolchain under voice/dependency-licenses. Include the complete dependency source/relinking materials appropriate to your native toolchain and Qt license when distributing it. See [release build instructions](docs/releases.md) for the pinned environments and build procedure.
