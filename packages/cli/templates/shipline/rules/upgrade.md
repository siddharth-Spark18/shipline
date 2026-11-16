# Upgrade rules

<!-- Repo-specific instructions Claude must follow in the "upgrade" stage. Filled in by /shipline-setup; edit freely. -->

- Follow `assessment.md`. Change only the dependencies it lists, using the repo's package manager, so the lockfile is updated the usual way.
- Make the code changes the breaking changes require, and no others. Don't refactor or fix unrelated things on the way.
- Run the install, then the repo's test, lint and build commands, to see the effect early. The verify stage runs them again.
- Record in `upgrade.md` what was bumped, what code changed and why, and anything left for later.
- Don't commit or open a pull request in this stage; that comes after verify.
