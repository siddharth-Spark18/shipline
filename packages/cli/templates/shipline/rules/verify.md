# Verify rules

<!-- Repo-specific instructions Claude must follow in the "verify" stage. Filled in by /shipline-setup; edit freely. -->

- Write `verification.md` with a `## Checklist` heading (the stage can't finish without it): each acceptance criterion checked against evidence, which is a test, a command's output, or something you saw.
- Run `node .shipline/bin/stage.mjs check`. It runs the test, lint and build commands set in `.shipline/config.yml` and records the results; Shipline won't finish this stage without a passing run on the current code. Rerun it after any change to the code. Skip commands that are not set, and say so.
- For UI work, run the app and check it in a browser, including the empty, loading and error states.
- If something fails, say so plainly. Don't mark a criterion as met without evidence.
- Check the edge cases from the plan, not only the main path.
- Look at the final diff for leftovers: debug output, unrelated changes, files outside the plan.
- Don't commit or open a pull request until this stage is done.
