# Verify rules

<!-- Repo-specific instructions Claude must follow in the "verify" stage. Filled in by /shipline-setup; edit freely. -->

- Check each acceptance criterion against evidence: a test, a command's output, or something you saw. Record the evidence in `verification.md`.
- Run the test, lint and build commands set in `.shipline/config.yml` and record each one's result. Skip any that are not set, and say so.
- For UI work, run the app and check it in a browser, including the empty, loading and error states.
- If something fails, say so plainly. Don't mark a criterion as met without evidence.
- Check the edge cases from the plan, not only the main path.
- Look at the final diff for leftovers: debug output, unrelated changes, files outside the plan.
- Don't commit or open a pull request until this stage is done.
