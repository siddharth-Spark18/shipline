# Root cause rules

<!-- Repo-specific instructions Claude must follow in the "root_cause" stage. Filled in by /shipline-setup; edit freely. -->

- Write `root-cause.md` with a `## Cause` heading and an `## Evidence` heading (the stage can't finish without them). Under Cause, state the cause. Under Evidence, give file and line evidence that someone else can check.
- Explain why it happens, not only where. Trace it from the symptom back to the first thing that goes wrong.
- Say what else the cause affects: other callers, other inputs, similar code paths.
- Check the cause against the reproduction. If fixing it would not make the failing case pass, it is not the cause.
- Separate what you verified from what you suspect.
- No fix yet. The fix comes in the next stage.
