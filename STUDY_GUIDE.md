# Study Guide — Multi-Agent Code Review System

Not part of the graded submission — for revisiting this project calmly later. Explains how the Claude
Agent SDK / MCP pieces actually fit together here, the real design decisions made while building it,
and the real compile-time and runtime issues hit along the way (with the actual fix for each).

---

## 1. The architecture, in one sentence

One top-level `query()` call fetches the PR's changed files via the **GitHub MCP server**; then, for
**each file**, a second `query()` call registers all three subagents and tells the model to delegate
to them **in parallel via the built-in `Task` tool**, requesting the combined result back as one
JSON-Schema-validated object — never three separate top-level calls per subagent.

Why that specific shape, and not "call each subagent directly"? Two reasons:

1. **It matches how the SDK's own subagent feature is meant to be used.** `AgentDefinition` objects
   passed via `options.agents` are *only* invokable through the `Task` tool by a parent agent — they
   aren't standalone callables. If the orchestrator called `codeQualityAnalyzer`'s prompt directly as
   its own top-level `query()`, the `AgentDefinition` object itself would never actually be exercised;
   you'd just be duplicating its prompt text into a manual call.
2. **It's what the reference lesson pattern (`lesson-10-multi-agent-orchestration`) demonstrates**:
   one coordinating prompt, `allowedTools: ['Task']`, `agents: {...}`, and an instruction to invoke
   multiple named subagents "in parallel" in a single response. This project's per-file review call is
   a direct application of that pattern, just parameterized by file instead of by research topic.

## 2. Why the file-fetch and the per-file review are *two separate* `query()` calls

It would be possible to give one giant call both GitHub MCP tools *and* the three agents, and let a
single top-level agent do everything: list files, then delegate each one. This project splits it
instead, and the split has a real justification tied to production reliability:

- The **file-fetch call** is a single, cheap, mostly-deterministic operation (list PR files, get their
  content). It gets its own rate-limit/retry/timeout wrap, and if it fails, nothing downstream even
  starts.
- The **per-file review call** is the expensive, failure-prone part (three subagents reasoning over
  real code). Splitting it out means each file's review is its own retryable unit — if file B's
  subagents fail even after retries, file A's already-successful review isn't thrown away. This is
  exactly what `Promise.allSettled` (see §5) buys you, and it only works because file reviews are
  already separate `query()` calls to begin with.

## 3. Structured outputs: Zod → JSON Schema → SDK → Zod again

The data flow for any structured result in this project is a round trip:

```
Zod schema (src/types/*.ts)
   → zod-to-json-schema, { $refStrategy: 'root' }   (so nested schemas inline instead of leaving $ref)
   → passed as options.outputFormat = { type: 'json_schema', schema }
   → the SDK returns message.structured_output (already-parsed JSON, untyped)
   → SchemaName.parse(message.structured_output)     (re-validated with the *original* Zod schema)
```

The last step matters: the SDK's structured-output feature makes the *model* conform to the schema,
but nothing stops a bug in *your own* aggregation code from producing an object that's syntactically
JSON but semantically wrong (wrong enum casing, a field left `undefined`). Running it back through
`.parse()` (not just trusting the JSON came back) is what `tests/schemas.test.ts` exists to give you
confidence in — see §7.

`$refStrategy: 'root'` specifically: without it, `zod-to-json-schema` emits `$ref: "#/definitions/Foo"`
pointers for nested schemas (like `CodeQualityResultSchema` nested inside `FileReviewSchema`). The SDK
document for structured outputs calls out that some validators don't dereference those — inlining
everything into one flat schema (`$refStrategy: 'root'`) sidesteps that class of failure entirely.

## 4. Two SDK-shape surprises found by actually reading the type definitions

Neither of these is documented prominently in the lesson prose — both were found by reading the
installed `@anthropic-ai/claude-agent-sdk`'s own `.d.ts` files when something didn't type-check or
behave as expected.

### `AgentDefinition.model` only accepts 4 literal strings

Naively, you might set `model: process.env.ANTHROPIC_MODEL` on each `AgentDefinition`, matching what
the top-level `query()` options take. This fails to compile: `AgentDefinition.model` is typed as
`'sonnet' | 'opus' | 'haiku' | 'inherit' | undefined` — a small enum, not an arbitrary model ID string.
The fix used throughout `src/agents/*.ts` is `model: 'inherit'`, which the SDK docs describe as
"uses the main model" — i.e., whatever model the *top-level* `query()` call was given (which *does*
accept an arbitrary string, from `process.env.ANTHROPIC_MODEL`). This is also the only choice that
keeps subagent model selection driven by one env var instead of being hardcoded per file.

### `SDKSystemMessage.mcp_servers` is an array, not a record

It's tempting to write `for (const [name, server] of Object.entries(message.mcp_servers))` when
checking MCP connection status on the `system`/`init` message — treating it like a `{name: status}`
dictionary. The actual type (`entrypoints/sdk/coreTypes.d.ts`) is:
```ts
mcp_servers: { name: string; status: string }[];
```
An **array** of `{name, status}` objects. `orchestrator.ts`'s init-message handling iterates it
directly (`for (const server of message.mcp_servers)`) rather than treating it as a keyed object —
using the wrong shape wouldn't throw at compile time if left loosely typed, but would silently iterate
zero real entries at runtime (`Object.entries()` on an array gives you index/value pairs, not
name/status pairs).

**The generalizable lesson:** when an SDK's runtime behavior doesn't match your first guess, the
`.d.ts` files under `node_modules/@anthropic-ai/claude-agent-sdk/` are the actual contract — read them
before guessing twice.

## 5. Graceful degradation: `Promise.all` vs `Promise.allSettled`

The first working version used `Promise.all(files.map(reviewFile))` to review every changed file
concurrently. That has a sharp edge: `Promise.all` rejects as soon as *any* promise rejects, discarding
the results of every file that *did* succeed. For a PR with 8 clean files and 1 file whose subagents
hit a transient failure (even after retries), the entire review would come back empty-handed.

The fix (`reviewPullRequest`, `src/orchestrator.ts`):
```ts
const settled = await Promise.allSettled(files.map((file) => this.reviewFile(file, tempDir)));
const fileReviews = settled
  .filter((r): r is PromiseFulfilledResult<FileReview> => r.status === 'fulfilled')
  .map((r) => r.value);
if (fileReviews.length === 0) throw new ReviewError(/* all failed */);
```
Only if *every single file* fails does the whole review fail — one bad file degrades the report
(fewer files reviewed, logged as a warning) instead of destroying it. This is covered by
`tests/orchestrator.test.ts`'s "should gracefully degrade" test, which mocks one file succeeding and
one failing and asserts the report still comes back with the successful one.

## 6. `permissionMode: 'bypassPermissions'` — why a CLI tool needs this at all

Claude Code sessions normally prompt a human before certain tool calls (writing files, running shell
commands) — that's the point of `permissionMode: 'default'`. This orchestrator runs as a **headless
CLI** (`npm run dev -- owner repo pr-number`), with nobody watching stdin to approve anything. Without
an explicit `permissionMode`, a session that hits a tool requiring approval would either block forever
waiting for input that never comes, or fail depending on the runtime's non-interactive defaults.
`bypassPermissions` is the explicit statement "this session is fully automated; don't gate any tool
call on human approval" — appropriate here specifically *because* every tool available to these agents
is already scoped tightly (MCP servers with fixed capabilities, `Skill`, `Task`) rather than something
open-ended like unrestricted `Bash`.

## 7. Why `tests/schemas.test.ts` exists *separately* from `tests/orchestrator.test.ts`

`orchestrator.test.ts` mocks the entire SDK (`vi.mock('@anthropic-ai/claude-agent-sdk')`) and asserts
on the *orchestrator's* control flow — does it call `query()` with the right options, does it retry,
does it degrade gracefully. It does **not** exercise the Zod schemas themselves with adversarial data,
because every mocked response in that file is hand-crafted to already be valid.

`schemas.test.ts` fills that gap directly: valid data parses, invalid enum values and missing fields
throw `ZodError`, boundary values (`overallScore` at exactly `0` and `100`) are accepted, and the
*exported JSON Schema* (not just the Zod schema) is checked for the `required` fields the SDK actually
needs to see. These are two different guarantees — "the orchestrator's logic is correct" and "the data
contracts themselves are correct" — and a bug in one wouldn't necessarily be caught by tests for the
other.

## 8. ESLint MCP needs a *real file on disk* — the one non-obvious plumbing detail

The `mcp__eslint__lint` tool (from `@eslint/mcp`) lints a file path, not a content string — it's a real
linter subprocess, not a text-analysis LLM tool. Since PR file content is fetched into memory (not
checked out from git), `code-quality-analyzer`'s ESLint pass only works if the orchestrator first
writes that content to an actual temp file before the per-file review call, and only registers the
`eslint` MCP server on that call when such a temp file exists (skipped entirely for non-JS/TS files,
where linting wouldn't apply anyway). This is why `mcpServers: tempPath ? { eslint: ... } : undefined`
is conditional in `runFileReviewQuery` rather than always-on.

## 9. Real end-to-end evidence already collected

`reports/diegoferreiracaetano-claude-code-1.{json,md,html}` in this repo is a genuine, live run against
a real public PR (deliberately seeded with a hardcoded secret, an `eval()` call on unsanitized input,
`==` instead of `===`, and zero tests) — not a mocked demo. The system caught all of it: overall score
15/100, the `eval()` flagged as **critical/security** (confirms the `security-analysis` Skill actually
fired), a missing-TypeScript-return-type note (confirms `typescript-patterns` fired), 5 prioritized test
gaps, and 5 concrete before/after refactor suggestions. This is the proof that the pipeline — GitHub
MCP fetch → parallel Task-based delegation → Skills → Zod validation → aggregation — genuinely works
beyond the mocked unit tests, before ever pointing it at the three required PRs.

## 9b. A real timeout bug, found by running against a different real PR

Once pointed at the three actually-required PRs (`kingpicollo222/simple-todo-app`, a public fork of
the assignment's template repo — see `CHECKLIST.md` for why a substitute repo was needed), PR #1's
first attempt **failed outright**: both changed files (`src/validators.js`,
`tests/validators.test.js`) hit `AGENT_TIMEOUT` on *all three* retry attempts:

```
2026-09-18 01:15:59 [warn]: Skipping file after review failed
{ "file": "src/validators.js", "error": "[RETRY_EXHAUSTED] ... [AGENT_TIMEOUT] Timed out reviewing file src/validators.js" }
```

**Root cause:** `fileTimeoutMs` defaulted to `120_000` (2 minutes) — a number that felt reasonable
against the earlier single-file test PR, but a per-file review here is genuinely expensive: one outer
`query()` call delegates via `Task` to all 3 subagents, one of which (`code-quality-analyzer`) also
invokes the ESLint MCP server as a separate tool call. For this PR's files, that routinely took longer
than 120 seconds. Because `withRetry` retries with the *same* timeout budget every attempt, and the
task consistently needed more time (not intermittently failing), **all three retries timed out
identically** — retrying bought nothing, since the problem wasn't transient.

**Fix:** raised the default to `240_000` (4 minutes) in `CodeReviewOrchestrator`'s constructor. All
three required PRs then completed on the very first attempt — durations were 250s, 192s, and 482s
respectively (PR #3's `subscription.js` took the longest, consistent with it also triggering the most
findings: 5 critical issues).

**The generalizable lesson** (this is basically System 1's "retry-vs-escalate" lesson from a *different*
capstone in this same course, applied to timeouts instead of missing data): **a timeout budget and a
retry count are only useful against different failure classes.** Retries help when failure is
*probabilistic* (a flaky network blip that might not recur). They do nothing when failure is
*deterministic given the budget* (the work genuinely needs more time than you've allotted it, every
time). Diagnosing which kind of failure you're looking at — here, by noticing all 3 attempts failed the
same way, not intermittently — is what tells you whether to add retries or raise the budget.

## 10. Quick command reference

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_MODEL, PROJECT_ROOT, optionally GITHUB_TOKEN

npm run lint      # tsc --noEmit
npm run build     # tsc (emits dist/)
npm test          # vitest run — orchestrator.test.ts + schemas.test.ts

npm run dev -- <owner> <repo> <pr-number>   # tsx src/main.ts, real API call
npm start -- <owner> <repo> <pr-number>     # runs the built dist/main.js instead
```
