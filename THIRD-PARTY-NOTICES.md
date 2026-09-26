# Third-party notices

- **Mumble** — BSD 3-Clause, The Mumble Developers. The native engine is built from the supplied source checkout. Its full license is copied to voice/MUMBLE-LICENSE. [Source](https://github.com/mumble-voip/mumble).
- **RNNoise** — BSD 3-Clause, Jean-Marc Valin and contributors. The full license is copied to voice/RNNOISE-LICENSE. [Source](https://github.com/xiph/rnnoise).
- **PhotinoX / PhotinoX.Native 5.3.0** — Apache 2.0. [Managed source](https://github.com/ivanvoyager/PhotinoX), [native source](https://github.com/ivanvoyager/PhotinoX.Native).
- **Qt 6** — the native build uses the installed static Qt libraries. Qt modules have their own LGPL/GPL/commercial licensing terms. Before distributing native binaries, include the applicable notices and satisfy the license for the Qt build you use, including any relinking/source requirements.
- **Other Mumble dependencies**, including Opus, SpeexDSP, OpenSSL, Protobuf, Boost, and libsndfile, retain their own licenses. Mumble's About/license UI and upstream 3rdPartyLicenses contain notices; the build preparation copies these notices alongside the engine.
- **Helltube** runs from the user's existing deployment. Its sources/assets are not copied into Strife.

These scripts build a local development artifact. Include the complete dependency license/source materials appropriate to your native toolchain and Qt license before distributing it.
