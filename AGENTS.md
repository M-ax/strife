# Working in Strife

## Keep website documentation in sync

Whenever pushing a new Strife build or build changes to `main` or `master`, always cross-check the changes against the neighboring `strife-web` repository before pushing. Review its landing page, getting-started wiki, download instructions, and release documentation. Update any affected feature descriptions, UI instructions, compatibility notes, or troubleshooting guidance, together with Strife's own documentation.

- Follow `strife-web/AGENTS.md`. Its `release.json` identifies the advertised packages and their source revision. Update version, filenames, and `sourceRef` only when they describe the actual new packages; distinguish source-only fixes from features available in the published downloads.
- When importing a new build or changing its manifest, run `npm run release:docs` in `strife-web` to regenerate marked website references. Run `npm run release:docs:check` and the applicable website build/tests before pushing documentation changes.
- Commit and push the related documentation changes as part of the same authorized push. Preserve unrelated work in either checkout. Report the documentation cross-check and both repositories' relevant commits, or state that no website changes were needed.
