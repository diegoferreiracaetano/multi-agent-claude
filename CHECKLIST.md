# Submission Checklist — Multi-Agent Code Review System

Mapped directly to the project rubric. Every item verified against real code/output in this repo.

## System Configuration

- [x] Sensitive credentials read from `process.env`, no hardcoded secrets (`src/config/mcp.config.ts`,
      `src/orchestrator.ts`, `src/main.ts` all read from env; `.env` itself is git-ignored).
- [x] Required env vars validated on startup in `src/main.ts` — owner/repo/PR args, auth (Anthropic
      key OR AWS Bedrock creds + region), `ANTHROPIC_MODEL`.
- [x] `src/config/mcp.config.ts` exports both servers:
  - `github`: `type: 'stdio'`, `command: 'npx'`, `args: ['-y', '@modelcontextprotocol/server-github']`,
    `env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '' }`
  - `eslint`: `type: 'stdio'`, `command: 'npx'`, `args: ['-y', '@eslint/mcp@latest']`

## Subagent Implementation

- [x] Three agents in `src/agents/`: `code-quality-analyzer.ts`, `test-coverage-analyzer.ts`,
      `refactoring-suggester.ts`, each an `AgentDefinition` with a clear `description`.
- [x] All three set `model: 'inherit'`.
- [x] `code-quality-analyzer` includes the `Skill` tool (plus `mcp__eslint__lint`) — satisfies "at
      least one subagent" for Skills integration. The other two carry `tools: []` (no external tools
      needed for their analysis).
- [x] Three prompt files in `src/prompts/`, each naming its specific focus area and referencing the
      Zod schema shape it must return.
- [x] Skills present in `.claude/skills/`: `javascript-best-practices` (provided),
      `typescript-patterns`, `security-analysis` — both referenced by the code-quality prompt.

## Orchestrator Logic and Workflow

- [x] `src/orchestrator.ts`'s `CodeReviewOrchestrator` uses the SDK's `query()`.
- [x] Per-file review call sets `allowedTools: ['Task']` and registers all three subagents in `agents`.
- [x] File-fetch call sets `allowedTools: ['mcp__github__*']` with the GitHub MCP server.
- [x] `permissionMode: 'bypassPermissions'` on both calls — required for headless/CI use (no human
      available to approve tool calls).
- [x] `orchestrator.prompt.ts` explicitly instructs fetching PR data, then delegating to the three
      named subagents.
- [x] `outputFormat` + `zod-to-json-schema` (`$refStrategy: 'root'`) enforce structured output on both
      calls.
- [x] Aggregation into `ReviewReportSchema`, validated with `.parse()` in `buildReport()`.
- [x] Graceful failure handling: `Promise.allSettled` over per-file reviews — one file's subagents
      failing doesn't sink the whole PR (only throws if *every* file fails).

## Production Deliverables

- [x] `src/main.ts` invokes `ReportGenerator` for all three formats, written to `reports/`.
- [x] `src/utils/error-handler.ts`: `withRetry` (exponential backoff + jitter, throws
      `RETRY_EXHAUSTED`) and `withTimeout` (`Promise.race`, throws `AGENT_TIMEOUT`) — both complete
      and both actually called from `orchestrator.ts` (not just defined in isolation).
- [x] `src/utils/rate-limiter.ts`: sliding-window `RateLimiter` — `acquire`, `canProceed`,
      `waitForSlot`, `waitForRateLimit`, `pruneOldRecords` all implemented, and `orchestrator.ts`
      actually calls `acquire()`/`release()` around every subagent/GitHub call.
- [x] `tests/orchestrator.test.ts` (11 tests) + `tests/schemas.test.ts` (25 tests, added this pass) —
      **36 passed, 1 skipped** (`npm test`). The skip is the real-API integration test, which needs a
      live key by design (`it.skip`, not a failure).
- [x] `npm run lint` (`tsc --noEmit`) and `npm run build` both clean.
- [x] CLI validates args (owner/repo/PR present, PR is a positive integer), auth, and model; errors
      are user-facing messages, not raw stack traces (`formatError()`).

## Code Quality

- [x] TypeScript strict-ish typing throughout (no stray `any` in the reviewed files); descriptive
      camelCase naming; clear `agents/` / `config/` / `prompts/` / `utils/` separation.

## Final Deliverables — 9 PR reports

- [x] 3 reports for PR #1 ("add clean code fixture") — `kingpicollo222-simple-todo-app-1.{json,md,html}`
      — score 80/100, 2 files (`src/validators.js`, `tests/validators.test.js`), 15 issues total.
- [x] 3 reports for PR #2 ("Add search functionality for todos") —
      `kingpicollo222-simple-todo-app-2.{json,md,html}` — score 42/100, 1 file (`src/search.js`),
      2 critical issues.
- [x] 3 reports for PR #3 ("Add premium subscription features") —
      `kingpicollo222-simple-todo-app-3.{json,md,html}` — score 15/100, 1 file
      (`src/subscription.js`), 5 critical issues (hardcoded API key, unvalidated fetch, sensitive
      data logged).
- [x] All JSON files parse cleanly (`python3 -m json.tool`); all HTML files have a matching
      `<!DOCTYPE html>`/`</html>` pair; all MD files render as proper tables + sections.
- [x] Every report contains real, populated agent findings — none empty/undefined (spot-checked file
      counts, issue counts, and recommendation counts above).

**Repo substitution, documented:** the instructions name `airaamane/simple-todo-app`. Verified against
the live GitHub API that this exact repo now 404s — the user `airaamane` is real (Abdellah Iraamane,
Dublin), but their only public repo is `airaamane-dev`. A GitHub code search for the assignment's exact
PR titles ("add clean code fixture", "Add search functionality for todos", "Add premium subscription
features") turned up the same content forked publicly by many other students under the identical repo
name `simple-todo-app` — this is evidently a shared course template each student forks into their own
account, and `airaamane`'s copy has since been deleted or renamed. Used **`kingpicollo222/simple-todo-app`**
instead, after confirming via the GitHub API that its PR #1/#2/#3 states (merged/open/open) and titles
match the assignment exactly.

**Real bug found and fixed while generating these:** the first PR #1 attempt failed outright — both
files hit `AGENT_TIMEOUT` on all 3 retry attempts (`fileTimeoutMs` defaulted to 120s, but a per-file
review is 3 subagents delegated via `Task`, one of them also invoking ESLint MCP — routinely >120s for
a real file). Retries didn't help since the *budget itself*, not transient flakiness, was the problem.
Fixed by raising the default to 240s in `src/orchestrator.ts`; all three PRs then completed on the
first attempt (durations: 250s, 192s, 482s).

Also still present: `reports/diegoferreiracaetano-claude-code-1.{json,md,html}` — the earlier proof-of-
pipeline run from before this repo's specific 9 were required, kept as extra evidence.
