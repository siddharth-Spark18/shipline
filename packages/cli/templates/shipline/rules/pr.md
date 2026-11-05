# Commit and PR rules

<!-- Repo-specific instructions Claude must follow in the "pr" stage. Filled in by /shipline-setup; edit freely. -->

- Use a branch named by `branch_pattern` in `.shipline/config.yml`. Never push to the default branch.
- Write a conventional commit message: a type, an optional scope, and a short summary in the imperative.
- The PR description has a summary of the change, a test plan, and a note on anything reviewers should look at closely. Summarize the plan and the verification result.
- Don't link task files; they're local.
- Run `node .shipline/bin/stage.mjs pr-summary` and paste its output unchanged at the end of the PR description. If it starts with a `Closes #<n>` line, keep it.
- Use `git` and `gh` with the developer's own credentials. Don't force-push or rewrite history that others have.
