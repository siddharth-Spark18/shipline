# How large and AI-heavy engineering orgs structure AI-agent development workflows

Date of research: 2026-11-05. Depth: deep (single researcher, one pass per sub-topic, cross-checked where possible).

## Question and scope

What development workflows do large tech and AI-heavy orgs (Google, Meta, Microsoft/GitHub, Amazon, Stripe, Shopify, Uber, Anthropic, OpenAI, Vercel, Linear, plus Spotify, Ramp, Cursor, Cognition where primary sources were found) use when building with AI coding agents? Covered: spec/plan-first vs vibe, design docs feeding agents, staged workflows, human checkpoints, work sizing, ticket trackers, background/async agents, multi-agent setups, friction/abandonment, published metrics. Context: reader is building an open-source stage-based workflow layer (ticket, feasibility, plan, implement, verify, PR, with confirmations) for Claude Code for teams.

Source labelling: [P] = primary (company's own blog/docs/paper), [S] = secondary (press, newsletter, aggregator), [V] = vendor marketing. I fetched every [P] page cited unless noted "search snippet only".

## Bottom line

1. No large org publishes a "ticket, feasibility, plan, implement, verify, PR" ritual as such. What the primary sources show is a split by autonomy level:
   - Interactive/IDE-or-CLI work: lightweight plan-then-implement with a human watching, spec-first tooling (Spec Kit, Kiro) where teams want rigor. Anthropic's own current docs de-emphasise ritual and emphasise "tell Claude what it can't see" and "give it a check to run".
   - Unattended/background work (Stripe, Spotify, Uber, Ramp, GitHub CCA, OpenAI): the "workflow" is encoded in the harness, not in human confirmations. Stages are mostly deterministic code (lint, test, push) wrapped around agent steps, with humans at two points: task intake (a well-scoped prompt/issue) and PR review/merge.
2. The stages that consistently survive in practice are: well-scoped intake, a machine-checkable "done" (tests/lint/verifiers), an independent review (fresh-context agent and/or human), and human accountability at merge. Mid-run human confirmations are rare in unattended systems (Stripe: "fully unattended"), and are mostly used in interactive spec-driven tools.
3. The dominant, repeatedly evidenced bottleneck is human review capacity, not generation. Multiple independent sources (Microsoft .NET, OpenAI, Uber, Spotify, a CMU/Stanford study as reported, Anthropic's own survey) converge here.
4. Setup (instructions file, build access, fast feedback) explains more of agent success than the model (Microsoft .NET data: 38.1% to 69% success mostly from setup changes).
5. Multi-agent: evidence favours single-writer with extra read-only reviewer/consultant agents; parallel-writer swarms see little adoption (Cognition, Apr 2026). Parallelism that works is across independent tasks/worktrees, not across agents on one change.
6. For the reader's tool: the staged model matches Spec Kit/Kiro for interactive work and matches what Stripe/Spotify do in a deterministic harness for unattended work. Confirmations are most defensible at (a) scope/plan approval and (b) merge; the evidence for per-stage confirmations in the middle is thin and anecdotal (see Disagreements).

## Findings

### 1. Spec/plan-first vs vibe coding

- GitHub Spec Kit (open source, GitHub blog, [P]) defines four gated phases: Specify, Plan, Tasks, Implement; "You don't move to the next phase until the current one is validated"; the authors say "The AI generates the artifacts; you ensure they're right." They argue vibe coding fails because vague prompts force the model to guess, and mistakes surface late; it remains "fine for quick prototypes." Notably the post presents no benchmarks and calls itself "our experiment." https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/
- Amazon Kiro docs ([P]): every spec has three phases (Requirements or Bug Analysis, Design, Tasks), each with a Review step where you comment on passages. Bugfix specs record current/expected/unchanged behaviour. "Quick Spec" skips approval gates for well-understood features. https://kiro.dev/docs/specs/
- Anthropic's Claude Code docs ([P]) offer a spec path ("Interview me until you could write the spec, then write it to SPEC.md", then build in a fresh session; review the diff against SPEC.md using a fresh subagent) but treat it as optional; the page's first line says "in most cases, your first plain prompt in a fresh session already does the right thing". The doc's "What you can stop doing" table drops old rituals (aggressive context management, emphasis in prompts). https://code.claude.com/docs/en/best-practices
- Anthropic internal teams ([P], July 2025): Security Engineering moved from "design doc, janky code, refactor, give up on tests" to pseudocode first then test-driven; Product Design maps error states up front. Reported mostly as anecdotes. https://claude.com/blog/how-anthropic-teams-use-claude-code
- Anthropic internal study ([P], Dec 2025, 132 survey responses, 53 interviews, ~200k transcripts): "Design and planning" share of Claude Code transcripts rose 1.0% to 9.9%; feature implementation rose 14.3% to 36.9%. Engineers also report "vibe coding" themselves into a corner. https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic
- OpenAI ([P], Dec 2025 talk summary): long runs use a continuously updated "plan file" / exec plan so "progress stayed legible to both people and models"; a 12-hour Bazel Diff Kotlin-to-Rust rewrite used sub-agents and a "watchdog" agent. https://forum.openai.com/home/blogs/how-openai-engineers-use-codex-to-tackle-big-projects-with-rigor-2025-12-04
- OpenAI "Harness engineering" post (Feb 2026): reported via search results/secondary sites only, because openai.com returned 403 to my fetch. Claim: ~1M lines in ~5 months, zero manually written code; human role = enabling agents; bottleneck became human QA capacity. Treat as OpenAI self-report, [S] for details. https://openai.com/blog/harness-engineering (not fetched)

Takeaway: spec-first is the documented answer for serious/brownfield interactive work; nobody publishes outcome data comparing spec-first vs not. That gap is real.

### 2. Design docs / RFCs feeding agents

Little primary evidence of "RFC feeds agent" as a formal pipeline. What exists:
- Context is delivered via repo files and tools: Stripe pre-fetches linked context deterministically and scopes rule files by subdirectory; its MCP server "Toolshed" has hundreds of tools. https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents and https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2
- Microsoft .NET: `.github/copilot-instructions.md`, firewall/package-feed access, and eight custom skills drove most improvement. https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/
- Spotify's interactive intake agent in Slack/GitHub gathers task info and writes the prompt for the coding agent. https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1
- Google: I found no primary description of design-doc-to-agent workflows (search returned only DESIGN.md from Google Labs via aggregators). Gap.

### 3. Staged workflows and where humans sit

Interactive (human present):
- Spec Kit / Kiro: human approves after each of 3-4 artifacts (above).
- Anthropic: Security Engineering "checks in with Claude periodically rather than letting it run unattended"; Product Design sets autonomous loops and reviews after. Docs: watch the first minute, Esc on drift, after two failed corrections `/clear` and re-prompt. https://code.claude.com/docs/en/best-practices
- Anthropic study: engineers start with simple tasks and extend delegation as trust builds; human turns per transcript fell 6.2 to 4.1 while consecutive tool calls rose 9.8 to 21.2.

Unattended (human at the ends):
- Stripe Minions ([P], Feb 2026): blueprints = code-defined workflows mixing deterministic nodes (linters, push) and agent nodes ("Implement task", "Fix CI failures"). Fully unattended, no mid-run steering; CI capped at ~two rounds (one full CI run, one retry), then branch goes to a human. Minion opens a PR with Stripe's template; engineer decides whether to request review or give the minion more instructions. Agents run with full permissions in an isolated devbox, "skip confirmation prompts". Over 1,300 PRs/week merged (Part 2), human-reviewed, no human-written code. Not described: success rate, cost, review time, task sizing.
- Spotify Honk ([P], Nov-Dec 2025): verifiers hidden from the agent; a Claude Code stop hook runs all relevant verifiers before a PR opens (no PR if one fails); an LLM judge compares diff to the original prompt last and vetoes ~25% of sessions, agent self-corrects about half the time; most common veto reason is scope creep. Judge has no formal evals yet. Spotify names its three failure modes: no PR (minor), PR fails CI, and PR passes CI but is functionally wrong ("most serious... erodes trust"). 1,500+ merged PRs; 60-90% time saving on migrations (self-reported). https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3
- GitHub Copilot coding agent ([P], docs): assign issue to Copilot, it opens a draft PR on a `copilot/` branch, requests review; the person who asked cannot approve the PR; later context should go on the PR, not the issue. https://docs.github.com/en/copilot/using-github-copilot/coding-agent/using-copilot-to-work-on-an-issue and https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/ (search snippets plus doc titles; I did not fetch the GitHub docs page itself)
- OpenAI Codex team ([S], Pragmatic Engineer, Feb 2026, partly paywalled): AI review auto-runs when PR leaves draft; ~90% of AI comments valid per team; non-critical code may merge after AI review at engineer's discretion, core components need human review; nightly Codex runs surface issues reviewed each morning. https://newsletter.pragmaticengineer.com/p/how-codex-is-built
- Anthropic docs "Let Claude run without you" checklist ([P]): knows what done looks like; can check its own work; what it may touch; what stops it (max turns/budget); where the result goes and who signs off. "The parts that stay with you are starting it, deciding what 'done' means this time, and approving the merge." https://code.claude.com/docs/en/best-practices

Pattern: humans define "done" up front and approve the merge; in-between checks are automated (deterministic first, LLM judge/reviewer second).

### 4. Work sizing, hotfixes

- Microsoft .NET data ([P], 878 PRs, May 2025-Mar 2026): success (merged/(merged+closed)) 67.9% overall vs 87.1% for human Microsoft PRs. Best categories: removal/cleanup 84.7%, testing 75.6%, refactoring 69.7%, clear-issue bug fixes 69.4%. Changes of 1-50 lines ~76-80%; 101-500 lines 64%. Weak: performance work 54.5%, native/platform-specific code, architectural decisions, open-ended requests ("does the minimum asked"). Caveat from author: task selection is deliberate so comparisons are directional. https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/
- Anthropic study: tasks expected under ~10 minutes often not worth prompting; delegation favours easy-to-verify, low-stakes, self-contained, boring work; design/taste stays human. Most engineers say they can "fully delegate" only 0-20% of work. 8.6% of tasks are "papercuts".
- Linear ([P], docs): delegation "works best on well-scoped issues with a clear description and acceptance criteria". https://linear.app/enablement/guide/ai-agents
- Addy Osmani ([P] personal blog, citing Faros/CodeRabbit - vendors): keep agent PRs small; tier review by blast radius; require evidence (test output); read test changes first because agents may rewrite assertions. https://addyosmani.com/blog/agentic-code-review/
- Hotfixes: I found no primary source describing a distinct hotfix path for agent work. Stripe does mention parallel minions "especially useful during on-call". Amazon (press) imposed stricter sign-off after outages (below). Gap.
- Large mechanical changes (migrations) are the sweet spot for background agents: Spotify, Google (75% claim plus migration 6x faster, self-reported), Uber Shepherd, Claude Code `/batch` splits into 5-30 units and shows a plan before fan-out. Google: https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/cloud-next-2026-sundar-pichai/ (search-snippet only; fetch of a guessed URL 404'd, this URL is from search results and not fetched).

### 5. Ticket trackers with agents

- Linear ([P]): agents are workspace members; you delegate via the Assignee field; human stays primary assignee, agent added as contributor; background agent opens a PR linked to the issue; "Delegating doesn't transfer accountability"; treat output as anyone else's through normal review; views filtered by Delegate and Insights show active/errored sessions. Cursor's Linear integration (Aug 2025 changelog) plans and implements from issue context. https://linear.app/enablement/guide/ai-agents and https://linear.app/changelog/2025-08-21-cursor-agent
- Stripe: minions launch from Slack, docs platform, feature-flag platform, ticketing UI; CI auto-creates flaky-test tickets with a "start a minion" button.
- GitHub: issue assignment is the trigger (above). Microsoft .NET: "Every CCA PR was requested by a maintainer. The agent cannot open PRs on its own."
- Third-party (Hookdeck guide, [S]): Cyrus bridges Linear to Claude Code via git worktrees. Not evidence of org practice.
- Gap: Shopify, Meta, Google ticket-agent workflows - nothing primary found.

### 6. Background/async agents producing PRs

- Stripe 1,300+/week (above). Uber ([S] Pragmatic Engineer, Mar 2026, paywalled mid-article): Minion platform, agents open ~11% of PRs; engineers kick off several background agents; 84% agentic users; AI costs up ~6x since 2024; "Top-down mandates are less efficient than engineers sharing their wins with peers". Uber's own uReview post ([P] via search, not fetched): AI review of every commit in median 4 min. https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development
- Ramp Inspect ([S]): figures conflict (~30% Jan 2026, "over half" Feb, 74% elsewhere); Ramp's own post not found. Treat as unverified. https://infoq.com/news/2026/01/ramp-coding-agent-platform/
- OpenAI: Codex engineers run 4-8 parallel agents, tasks 20-30 minutes up to an hour ([S] Pragmatic Engineer). Anthropic: one engineer estimates 70%+ of time now review.
- Vercel ([S]): search found CEO claims (half of 6M daily deployments triggered by coding agents) and d0 data-agent rebuild; no primary engineering post on dev workflow. Weak evidence.

### 7. Multi-agent setups

- Cognition ([P], Apr 2026): what works = clean-context reviewer (Devin Review finds ~2 bugs per Devin PR, ~58% severe per Cognition), "smart friend" escalation, manager-with-children delegation; "writes stay single-threaded". Parallel-writer swarms: little adoption, produce fragile conflicting decisions. Reviewer needs a bridge back to the coder or loops drift. Vendor data. https://cognition.com/blog/multi-agents-working
- Cursor ([V]/P blog, search snippet only): planner/worker roles beat lock-based coordination; hundreds of workers can push to one branch with few conflicts; periodic fresh starts combat drift. https://cursor.com/blog/scaling-agents
- Anthropic docs: subagents help with parallelism, noisy output, and independent review; "Handing the same task to a subagent doesn't make the answer any better. A fresh reviewer does help." Cost is tokens. Use read-only reviewer subagent (`tools: Read, Grep, Glob`) checking the diff against the spec.
- OpenAI: agents review agents ("infinite review loop" in secondary summaries); OpenAI forum post says Codex reviews every internal PR.

### 8. Metrics: share of code AI-written and throughput (all self-reported unless noted)

- Google: 75% of new code AI-generated and engineer-approved (Pichai, Apr 2026), up from 50% in fall 2025. Self-reported; definition not published.
- Anthropic: merged PRs per engineer per day +67% after Claude Code adoption (directional); self-reported productivity +50%; usage 59% of daily work.
- OpenAI: Codex wrote >90% of Codex app code (team estimate); engineers using Codex ship ~70% more merged PRs (OpenAI talk).
- Uber: 65-72% AI-generated in IDE tools, 100% for CLI tools (as reported); agents open 11% of PRs.
- Stripe: 1,300+ minion PRs/week. Spotify: 1,500+ merged agent PRs (Nov 2025).
- Meta ([S] only): targets (50-80% AI-assisted for some orgs; 75% for 65% of one org's engineers in H1 2026), "AI-driven impact" in performance reviews; no verified AI-code share; one report that Zuckerberg said agents "haven't accelerated" as expected. Targets, not outcomes.
- Shopify ([S]): April 2025 memo making "reflexive AI usage" a baseline, tied to performance reviews and headcount requests; AI in the prototype phase. No primary fetch; no workflow data.
- Microsoft: .NET data above; GitHub dogfooding claim of ~1,000 merged Copilot PRs in 3 months ([S]).
- Amazon ([S] press, secondary, not verified against Amazon): Kiro standardised with an 80% weekly-use target (Nov 2025 memo per press); reported outages; senior-engineer sign-off for AI-assisted changes on ~335 tier-1 systems for 90 days; Amazon reportedly attributes incidents to user error. TechRadar page fetch returned no article body, so I could not verify.

### 9. Friction, abandonment, failure modes

- Review bottleneck: .NET: "Review capacity becomes the bottleneck when generation is cheap"; 44% of closed CCA PRs were auto-closed unreviewed drafts. Anthropic: engineers do more review, extra cognitive load on unfamiliar code, skill-atrophy and mentorship concerns. CMU/Stanford "AI Writes Faster Than Humans Can Review" (arXiv 2607.01904, as reported by Semgrep, Oct 2026, [S]; I did not open the paper): 802 developers, ~200k PRs, PR volume 3.1x vs reviewer pool 1.5x; PRs receiving written human feedback fell 39% to 21%; AI-authored PRs ~20% slower from first review to merge. https://semgrep.dev/blog/2026/end-is-nigh-for-code-review
- Verification theatre: agents may weaken tests/CI to get green (Spotify judge catches disabled flaky tests; Osmani). Functionally wrong but CI-green PRs are the trust-killer (Spotify).
- Scope creep (Spotify's top veto reason); open-ended requests where agent does the minimum (.NET). Cold-start/context problem (Anthropic): engineers skip delegating because prompting is costlier than doing.
- Unverifiable work: performance claims, native/platform code, anything the sandbox cannot run (.NET, Spotify).
- Sandbox permissions vs adoption: OpenAI's Tibo says default sandboxing "hurts us in terms of general adoption" ([S]).
- Cost: Uber ~6x AI cost since 2024; Stripe caps CI rounds for cost/diminishing returns.
- Adoption: Uber says adoption slower than expected; mandates less effective than peer sharing. Microsoft reportedly moved internal teams between tools ([S], conflicting reports).
- Productivity evidence is mixed: METR 2025 RCT (16 experienced devs, 246 tasks): 19% slower while believing 20% faster ([S] summaries); METR's 2026 follow-up is described only in secondary sources as inconclusive/selection-biased, and its own March 2026 post URL I guessed 404'd. DORA 2025 ([S] summaries; ~5,000 respondents, 90% AI adoption): higher throughput but more instability; AI is an "amplifier" of existing org strengths/weaknesses.
- Data from vendors selling review tooling (Faros, CodeRabbit, Semgrep, Cognition) should be read as interested.

## Implications for a stage-based Claude Code workflow (inference, not sourced)

- Stages map well onto what is evidenced: scoped intake (Linear/.NET/Spotify all say scope and acceptance criteria drive success) -> feasibility/plan (Spec Kit, Kiro, Anthropic spec interview) -> implement -> verify -> PR. Make verify deterministic (hooks/tests) with an independent fresh-context reviewer, as Spotify/Anthropic/Cognition do.
- Put human confirmations at plan approval and PR/merge; consider making mid-stages auto-advance when checks pass, since Stripe/Spotify run unattended between those points.
- Add: scope-creep check (diff vs approved plan), hard caps on retry rounds, evidence requirement in the PR, size/risk tiering of review, and a small-vs-large path (Kiro "Quick Spec" and "skip planning if you could describe the diff in one sentence"-style fast lane; note the latter phrase came from a secondary summary of Anthropic guidance and I did not verify it in the primary docs).
- Team-level: shared instructions file and skills had the biggest measured effect (.NET).

## Disagreements and uncertainty

- "Plan first" necessity: Spec Kit/Kiro advocate gated phases with no outcome data; Anthropic's current docs say the default prompt usually works and give specs as an option; Stripe/Spotify skip human gates mid-run. No controlled comparison found.
- AI-code share figures are not comparable (Google "new code, approved", Uber "IDE vs CLI", Meta targets, Ramp conflicting 30%/50%/74%).
- Stripe PR counts: ~1,000/week (Part 1) vs 1,300/week (Part 2), reported by Stripe in different posts weeks apart.
- Amazon incident causation and mandate status: conflicting press; no Amazon primary.
- Spotify judge veto rate: ~25% of sessions per the post; some summaries say 25% of changes.
- METR follow-up and DORA instability details come from secondary summaries.
- Anthropic best-practices page I fetched refers to "Opus 5.5"/"Sonnet 5.5" defaults, consistent with the present date; older third-party summaries of an "explore, plan, code, commit" workflow reflect the earlier (2025) docs and were not verified in the current page.

## Not found / gaps

Meta primary engineering sources; Shopify primary workflow content (only the April 2025 memo via press); Google internal workflows; Vercel engineering post on dev workflow; Linear's own use of agents internally; hotfix-specific agent workflow anywhere; Uber Minion primary post; Ramp primary post; Stripe task-sizing or success-rate data; harness-engineering post full text (403).

## Sources

- Stripe, Minions Part 1, 2026-02-09 [P]: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents
- Stripe, Minions Part 2, 2026-02-19 [P]: https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2
- Spotify, Honk Part 1, 2025-11-06 [P]: https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1
- Spotify, Honk Part 3, Dec 2025 [P]: https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3
- Microsoft .NET, Ten Months with Copilot Coding Agent, 2026-03-23 [P]: https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/
- GitHub, Spec-driven development / Spec Kit, Sep 2025 [P]: https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/
- Kiro docs, Specs [P]: https://kiro.dev/docs/specs/
- Claude Code best practices [P]: https://code.claude.com/docs/en/best-practices
- Anthropic, How Anthropic teams use Claude Code, 2025-07 [P]: https://claude.com/blog/how-anthropic-teams-use-claude-code
- Anthropic, How AI is transforming work at Anthropic, 2025-12-02 [P]: https://www.anthropic.com/research/how-ai-is-transforming-work-at-anthropic
- OpenAI forum, How OpenAI engineers use Codex, 2025-12-04 [P]: https://forum.openai.com/home/blogs/how-openai-engineers-use-codex-to-tackle-big-projects-with-rigor-2025-12-04
- Pragmatic Engineer, How Codex is built, 2026-02-17 [S]: https://newsletter.pragmaticengineer.com/p/how-codex-is-built
- Pragmatic Engineer, How Uber uses AI for development, 2026-03-10 [S]: https://newsletter.pragmaticengineer.com/p/how-uber-uses-ai-for-development
- Linear, Working with agents [P]: https://linear.app/enablement/guide/ai-agents
- Linear changelog, Cursor agent, 2025-08-21 [P, snippet only]: https://linear.app/changelog/2025-08-21-cursor-agent
- Cognition, Multi-Agents: What's Actually Working, 2026-04-22 [P/V]: https://cognition.com/blog/multi-agents-working
- Addy Osmani, Agentic Code Review [P, personal blog citing vendor data]: https://addyosmani.com/blog/agentic-code-review/
- Semgrep, The End Is Nigh for Code Review, 2026-10-09 [S/V]: https://semgrep.dev/blog/2026/end-is-nigh-for-code-review
- Google, Pichai Cloud Next 2026 post, Apr 2026 [P, snippet only]: https://blog.google/innovation-and-ai/infrastructure-and-cloud/google-cloud/cloud-next-2026-sundar-pichai/
- Cursor, Scaling agents [V, snippet only]: https://cursor.com/blog/scaling-agents
- GitHub Docs, Using Copilot to work on an issue [P, snippet only]: https://docs.github.com/en/copilot/using-github-copilot/coding-agent/using-copilot-to-work-on-an-issue
- InfoQ, Ramp coding agent platform, Jan 2026 [S, snippet only]: https://infoq.com/news/2026/01/ramp-coding-agent-platform/
- Amazon/Meta/Shopify/Vercel/METR/DORA items: search-result summaries only (not fetched), listed inline as [S].
