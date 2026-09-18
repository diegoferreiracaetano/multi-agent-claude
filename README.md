# Enterprise Multi-Agent Code Review Orchestrator — Submission

A production-ready multi-agent code review system built on the Claude Agent SDK: one orchestrator
fetches a GitHub PR's changed files via MCP, delegates each file to three specialized subagents in
parallel via the `Task` tool, and aggregates their findings into a single Zod-validated report,
rendered as Markdown/HTML/JSON.

**Read first:** [`CHECKLIST.md`](CHECKLIST.md) (every rubric item mapped to real code/output) ·
[`STUDY_GUIDE.md`](STUDY_GUIDE.md) (not graded — a detailed walkthrough of the architecture and every
real bug found while building it, for revisiting later)

## Architecture

```
                    MAIN ORCHESTRATOR (src/orchestrator.ts)
              1. Fetch PR files          — GitHub MCP
              2. Per file, delegate      — Task tool, 3 subagents, in parallel
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
 Code Quality        Test Coverage        Refactoring
  Analyzer             Analyzer            Suggester
 (Skill + ESLint)      (Skill)             (Skill)
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
              ReviewReport (Zod-validated JSON)
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   report.md          report.html          report.json
```

## What's implemented

| Piece | File(s) |
|---|---|
| MCP config (GitHub + ESLint) | `src/config/mcp.config.ts` |
| 3 subagents (`AgentDefinition`, `model: 'inherit'`) | `src/agents/*.ts` |
| 4 prompts (orchestrator + one per subagent) | `src/prompts/*.ts` |
| Orchestrator (fetch → delegate → aggregate → validate) | `src/orchestrator.ts` |
| CLI (arg/auth/model validation, report writing) | `src/main.ts` |
| Retry with exponential backoff + timeout wrapper | `src/utils/error-handler.ts` |
| Sliding-window rate limiter, wired into every API call | `src/utils/rate-limiter.ts` |
| Schema validation tests + orchestrator behavior tests | `tests/schemas.test.ts`, `tests/orchestrator.test.ts` |
| 2 required Skills (+ 1 provided) | `.claude/skills/{typescript-patterns,security-analysis,javascript-best-practices}` |

## Setup

```bash
npm install
cp .env.example .env   # set ANTHROPIC_MODEL, PROJECT_ROOT, optionally GITHUB_TOKEN
```

## Verify

```bash
npm run lint    # tsc --noEmit
npm run build   # tsc
npm test        # vitest — 36 passed, 1 skipped (live-API integration test)
```

## Run

```bash
npm run dev -- <owner> <repo> <pr-number>
```

## Reports

`reports/` contains generated analysis reports, three files per PR (`.json`, `.md`, `.html`). See
`CHECKLIST.md` for exactly which PRs are included and the status of the required
`airaamane/simple-todo-app` deliverables.

## Key technologies

Claude Agent SDK · Model Context Protocol (GitHub, ESLint) · Zod (+ `zod-to-json-schema`) ·
TypeScript · Claude Skills · Vitest · Winston
