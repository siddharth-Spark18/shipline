# Fix rules

<!-- Repo-specific instructions Claude must follow in the "fix" stage. Filled in by /shipline-setup; edit freely. -->

- Make the smallest change that fixes the cause found in the root cause stage. Don't fix unrelated problems on the way.
- Add a regression test that fails without the fix and passes with it, when the repo has tests.
- Follow the repo's existing patterns and style.
- Check the other places the root cause said are affected, and fix or note them.
- Note what you changed and why in the stage's artifact, including anything you chose not to change.
- Don't commit or open a pull request in this stage; that comes after verify.
