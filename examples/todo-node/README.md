# todo-node

A tiny Node module (an in-memory todo list, about 50 lines) to try [Shipline](../../README.md) on. It has a test
command and a lint command, which is what Shipline's Verify stage runs. It contains no Shipline files: you
install them yourself below. It isn't part of the npm package.

```bash
npm test         # node --test
npm run lint     # node --check src/todo.js
```

## Try it

Shipline works in a git repo, so copy this folder out of the Shipline checkout and start one:

```bash
cp -R examples/todo-node ~/todo-node && cd ~/todo-node
git init -b main && git add . && git commit -m "Initial commit"

npx @forgeyard/shipline init --yes
git add -A && git commit -m "Add Shipline"
```

`init --yes` detects `npm test` and `npm run lint` from `package.json` and installs the defaults. It sets the tracker
to None, so the ticket stage is skipped. Then open Claude Code in the folder and ask for a change:

```bash
claude
> Add a way to delete a todo
```

## What you should see

Claude calls this a feature and asks once before starting:

```
This looks like a feature, so I'll follow the Feature workflow. OK?
```

After you say yes, it creates a task and lists the stages (the ticket stage is skipped because there is no tracker):

```
[-] ticket (No tracker)
[>] feasibility
[ ] questions
[ ] plan
[ ] implement
[ ] verify
[ ] pr
```

It writes `feasibility.md`, then `questions.md` with the things it needs to know (for example "What should
`remove` return for an unknown id?"). Stages that need your OK ask with a question. At **Plan** you see the plan and
choose **Advance** or **Not yet**; until the plan is done, edits to `src/` and `test/` are refused. Then Claude
implements the change on a branch such as `feature/delete-a-todo`.

At **Verify** it runs `node .shipline/bin/stage.mjs check`, which runs `npm test` and `npm run lint` and prints:

```
Running test: npm test
Running lint: npm run lint

test ✓ 0.2s · lint ✓ 0.1s
Scope: no test, lint or CI files touched, nothing outside the plan
```

Adding tests for the new function is normal; if a change edits existing test files or touches files the plan didn't
list, the scope line says so and Claude asks you before finishing.

## A sample PR summary

At the **PR** stage Claude opens the pull request and ends its description with the output of
`node .shipline/bin/stage.mjs pr-summary`:

```markdown
### Shipline
| Stage | Status | Confirmed |
| --- | --- | --- |
| ticket | skipped | auto |
| feasibility | done | auto |
| questions | done | your answer |
| plan | done | your answer |
| wireframes | skipped | auto |
| implement | done | auto |
| verify | done | your answer |
| pr | pending | — |

**Checks:** test ✓ 0.2s · lint ✓ 0.1s

**Scope:** no test, lint or CI files touched, nothing outside the plan

<details><summary>Plan scope</summary>

Add `remove(id)` to the todo list and cover it with tests.

</details>
<!-- shipline:summary {"v":2,"workflow":"feature","task":"delete-a-todo","stages":[...]} -->
```

(The last line is hidden data for the optional CI check; it is longer in a real summary.) Which stages show as
"your answer" depends on your `confirmations` setting. Everything Shipline recorded for the task is in
`~/.shipline`, not in this folder.

## Things to try

- Ask for `cat .env` or `git push --force origin main`: the guardrails refuse them.
- Edit `.claude/settings.json` when Claude proposes it: Claude Code asks you first.
- Set `confirmations: light` in `.shipline/config.yml`: Claude then asks only at Plan.
- Run `npx @forgeyard/shipline ui` for the browser view of the same task.
