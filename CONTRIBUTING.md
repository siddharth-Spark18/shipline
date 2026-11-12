# Contributing

The repo holds only the CLI product:

```
packages/cli   the npm package: bin, src (init, upgrade, uninstall, UI server), templates (what init installs), tests
packages/ui    the React app behind `shipline ui` (built into packages/cli/ui-dist)
docs/          plans and images
.github/       CI and the publish workflow
```

```bash
pnpm install            # the only native build is esbuild
pnpm build:ui           # builds packages/ui into packages/cli/ui-dist
pnpm test               # all CLI tests (Node 22+)
```

After changing anything under `packages/cli/templates/`, run `node packages/cli/scripts/hash-templates.mjs` to
record the new template hashes. When a rules template changes, also keep the old text's hash in
`packages/cli/src/known-stub-rules.mjs`, so `upgrade` can still tell an untouched copy from an edited one.

**CI** (`.github/workflows/cli.yml`) runs the full suite, the UI typecheck and the bundle-size check on Node 22, 24
and 26 on Ubuntu, and on Node 22 and 26 on macOS and Windows.

**Releasing.** Bump the version in `packages/cli/package.json`, add a `## [<version>]` entry to
`packages/cli/CHANGELOG.md`, run the hash script, commit, then push a tag `v<version>` (for example `v1.0.0`).
`.github/workflows/publish.yml` checks that the tag matches the package version, that the CHANGELOG has the heading and
that the hashes are recorded, and publishes `@forgeyard/shipline` to npm through **trusted publishing** (GitHub's OIDC
identity, no npm token stored anywhere; the package's Settings → Trusted publishing on npmjs.com names this repo and
`publish.yml`). A version that is already on npm is skipped. 1.0.0 was published by hand to create the package, since
npm only accepts a trusted publisher for a package that already exists.

Older design documents live in `docs/plans/`; those describing the v1 hub are marked historical.
