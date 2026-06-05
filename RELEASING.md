# Releasing electron-syphon

Releases are **tag-driven**. You bump the version and write the changelog
locally (one command), push the tag, and GitHub Actions does the rest:
build the macOS/arm64 prebuild → publish to npm with provenance → cut a
GitHub Release.

```
  pnpm release            git push --follow-tags         GitHub Actions (macos-14)
  ─────────────  ───►  ─────────────────────────  ───►  ────────────────────────────
  bump version          pushes commit + vX.Y.Z tag       make-library (ts + prebuild)
  update CHANGELOG.md                                     npm publish --provenance
  commit + git tag                                        gh release create
```

## One-time setup

1. **`NPM_TOKEN` secret** — create an npm **Automation** token
   (npmjs.com → Access Tokens → Generate → Automation) and add it under
   the repo's *Settings → Secrets and variables → Actions* as `NPM_TOKEN`.
2. **Commit style** — releases derive the version bump and changelog from
   [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: …` → **minor** bump, listed under *Features*
   - `fix: …` / `perf: …` → **patch** bump, under *Bug Fixes* / *Performance*
   - `feat!: …` or a `BREAKING CHANGE:` footer → **major** bump
   - `build: …`, `refactor: …` → shown; `docs/test/ci/chore` → hidden
   Anything not following this convention is simply ignored by the changelog.

## Cutting a release

```bash
# preview the next version + changelog without writing anything
pnpm release:dry

# bump version, regenerate CHANGELOG.md, commit, and create the vX.Y.Z tag
pnpm release                 # auto-picks the bump from your commits
# or force one:
pnpm release:patch
pnpm release:minor
pnpm release:major

# push the release commit + tag — this is what triggers the pipeline
pnpm release:push            # = git push --follow-tags origin main
```

That's it. Watch the run under the repo's **Actions** tab; when it's green
the package is live on npm and a GitHub Release exists.

## Pre-releases

```bash
pnpm release -- --prerelease beta   # e.g. 0.2.0-beta.0, published on npm dist-tag via the workflow
pnpm release:push
```

The workflow marks any tag containing a `-` (e.g. `v0.2.0-beta.0`) as a
GitHub *pre-release* automatically.

## Notes & caveats

- **arm64 only.** The vendored `Syphon.framework` is Apple-Silicon only, so
  the shipped prebuild (and `package.json` `cpu`/`os` fields) target
  `darwin/arm64`. To ship Intel/universal binaries you'd need a universal
  `Syphon.framework`, then build with `ARCHS="arm64 x86_64"` in CI.
- **Provenance.** `publishConfig.provenance: true` + the workflow's
  `id-token: write` permission produce a signed npm provenance attestation —
  no extra flags needed.
- **The tarball is built twice** (once to verify, once attached to the
  Release) so the GitHub Release artifact byte-matches what npm received.
- Prefer `pnpm release` over hand-editing the version — it keeps
  `package.json`, the git tag, and `CHANGELOG.md` in lockstep.
