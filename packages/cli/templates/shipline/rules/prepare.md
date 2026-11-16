# Prepare rules

<!-- Repo-specific instructions Claude must follow in the "prepare" stage. Filled in by /shipline-setup; edit freely. -->

- Write `release-notes.md` with a `## Version` heading and a `## Changes` heading (the stage can't finish without them, each with real text under it).
- Under Version, give the new version number and why it is that level of change (major, minor or patch), following the repo's versioning scheme. Say which files carry the version.
- Under Changes, list what is in the release since the last one, grouped as the repo's changelog groups them. Read the git log and merged pull requests; don't write from memory.
- Call out breaking changes, migrations and anything operators must do before or after the release.
- Follow the repo's changelog format. Update the changelog and the version only if the developer asked you to in this stage.
- Don't tag, publish or deploy in this stage.
