# Publish rules

<!-- Repo-specific instructions Claude must follow in the "publish" stage. Filled in by /shipline-setup; edit freely. -->

- Follow the repo's release process, step by step (its docs or CI). Do each step the developer has confirmed, and show the command before you run it.
- Re-check that the branch, version and changelog match `release-notes.md` and the verified commit. Stop and ask if anything differs.
- Don't skip hooks or checks, and don't force-push. Use the developer's own credentials.
- Record in `publish.md` what was released: version, tag, where it was published, the link to the release, and anything that failed or still needs doing (for example a deploy that another team runs).
- If a step fails, stop and tell the developer. Don't retry destructive steps on your own.
