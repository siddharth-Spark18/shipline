# Assess rules

<!-- Repo-specific instructions Claude must follow in the "assess" stage. Filled in by /shipline-setup; edit freely. -->

- Write `assessment.md` with `## Packages`, `## Breaking changes` and `## Risks` headings (the stage can't finish without them, each with real text under it).
- Under Packages, list each package with its current and target version, and whether it is a runtime or a development dependency.
- Under Breaking changes, read the changelogs and migration guides between the two versions. List what breaks, and search the code for the affected APIs, with file and line.
- Under Risks, cover transitive dependencies, peer dependency and engine requirements, licence changes, lockfile churn, and anything the tests do not cover.
- Prefer the smallest bump that solves the problem. Say when a bump should be split into several.
- No edits yet. Shipline blocks them until this stage is done.
