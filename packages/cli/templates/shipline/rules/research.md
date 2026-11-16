# Research rules

<!-- Repo-specific instructions Claude must follow in the "research" stage. Filled in by /shipline-setup; edit freely. -->

- Write `findings.md` with a `## Findings` heading and a `## Recommendation` heading (the stage can't finish without them, each with real text under it).
- Answer the question from `question.md` against its success criteria. Read the code, run read-only commands, and use documentation. Cite file and line, or the source, for each finding.
- Separate what you verified from what you assume. Say plainly when the answer is "not possible" or "unclear".
- Under Recommendation, give one clear next step (build it, drop it, or investigate further) with the main trade-off and the rough size of the work.
- Throwaway experiments are fine outside the repo's tracked files. Don't commit, and don't open a pull request: this workflow ends with findings, not a change.
