# Ticket rules

<!-- Repo-specific instructions Claude must follow in the "ticket" stage. Filled in by /shipline-setup; edit freely. -->

- Read the ticket read-only and save it to `ticket.md`: title, description, acceptance criteria, links and labels. Never create or edit issues or tickets.
- Use the tracker named in `.shipline/config.yml` (`tracker: jira` or `github`). If the developer pastes ticket details, use those instead.
- Jira: use the Atlassian tools. If they are not available (the connector is missing, needs authentication, or failed to start), skip this stage with `stage.mjs skip --reason "Jira not connected"`.
- GitHub: run `gh issue view <n> --json number,title,body,labels,url,state` and save the result. If `gh` is missing, not signed in, or the call fails, skip this stage with `stage.mjs skip --reason "GitHub not connected"`.
- The stage is optional, so don't ask the developer before skipping it.
- Copy acceptance criteria as written, as a checklist. If the ticket has none, say so in `ticket.md` instead of inventing them.
- Note linked tickets, parent epics and anything the ticket says is out of scope.
