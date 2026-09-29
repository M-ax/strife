# Working in Strife

## Keep native Mumble stable

Treat the pinned Mumble engine and its native integration as a stable dependency. Implement ordinary app features in the managed host or web UI; change the native bridge or upstream integration only when the required capability cannot be provided there. Preserve the compiled voice cache for app-only, documentation and packaging changes. Native bridge, build recipe or dependency changes must invalidate it so releases cannot ship a stale engine. Cached engines still require the normal package and startup checks.

## Keep website documentation in sync

An authorized build/release push includes publishing the installers and platform archives to R2, not just pushing source and updating website documentation, unless the user explicitly requests a source-only update. Build and validate all advertised platforms using the pinned native cache, choose a new immutable version, import the actual packages into `strife-web` with their exact source commit, and run `npm run release:upload` before deploying the updated website. Run `npm run release:verify` against production after deployment to verify every advertised download's bytes, SHA-256, headers, and range support. Do not report the release as published until R2 uploads, website deployment, and production verification succeed; report any blocked platform or publishing step explicitly.

Whenever pushing a new Strife build or build changes to `main` or `master`, always cross-check the changes against the neighboring `strife-web` repository before pushing. Review its landing page, getting-started wiki, download instructions, and release documentation. Update any affected feature descriptions, UI instructions, compatibility notes, or troubleshooting guidance, together with Strife's own documentation.

- Follow `strife-web/AGENTS.md`. Its `release.json` identifies the advertised packages and their source revision. Update version, filenames, and `sourceRef` only when they describe the actual new packages; distinguish source-only fixes from features available in the published downloads.
- When importing a new build or changing its manifest, run `npm run release:docs` in `strife-web` to regenerate marked website references. Run `npm run release:docs:check` and the applicable website build/tests before pushing documentation changes.
- Commit and push the related documentation changes as part of the same authorized push. Preserve unrelated work in either checkout. Report the documentation cross-check and both repositories' relevant commits, or state that no website changes were needed.
