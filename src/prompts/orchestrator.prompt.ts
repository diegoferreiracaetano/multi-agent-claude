/**
 * Prompt builders used directly by the orchestrator (not static AgentDefinition prompts).
 */

const MAX_FILE_CHARS = 6000;

export function truncateForPrompt(content: string, maxChars: number = MAX_FILE_CHARS): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n\n[... truncated, ${content.length - maxChars} more characters ...]`;
}

/**
 * Prompt for the one-shot call that fetches the PR's changed files via the GitHub MCP server.
 */
export function buildFetchFilesPrompt(
  owner: string,
  repo: string,
  prNumber: number,
  maxFiles: number = 8
): string {
  return `You have access to GitHub via MCP.

Fetch the list of files changed in this pull request:
- Owner: ${owner}
- Repository: ${repo}
- PR number: ${prNumber}

Steps:
1. Use the appropriate mcp__github__* tool to list the pull request's changed files.
2. Skip deleted files, binary files, lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml),
   and generated/build output (dist/, build/, node_modules/).
3. For each remaining file (up to ${maxFiles} files, prioritizing the ones with the most
   changes), fetch its full current content at the PR's head commit using the appropriate
   mcp__github__* tool.
4. If a file cannot be fetched, skip it rather than failing the whole request.

Return structured JSON matching exactly:
{
  "files": [
    { "path": string, "content": string }
  ]
}`;
}

export interface ReviewablePRFile {
  path: string;
  content: string;
}

/**
 * Per-file coordinator prompt: delegates one file to the three subagents
 * (code-quality-analyzer, test-coverage-analyzer, refactoring-suggester) in
 * parallel via the Task tool, then compiles their outputs into one structured result.
 */
export function buildFileReviewPrompt(file: ReviewablePRFile, eslintTempPath?: string): string {
  const content = truncateForPrompt(file.content);

  return `You are a code review coordinator. You have access to three subagents via the Task tool:
- code-quality-analyzer: security, performance, and maintainability review
- test-coverage-analyzer: identifies untested code paths
- refactoring-suggester: modernization and refactoring opportunities

Do not analyze the code yourself — always delegate to the subagents for that.

FILE PATH: ${file.path}
${eslintTempPath ? `LOCAL TEMP COPY (for ESLint, code-quality-analyzer only): ${eslintTempPath}` : ''}

FILE CONTENT:
\`\`\`
${content}
\`\`\`

WORKFLOW:
1. Invoke all three subagents IN PARALLEL (call Task multiple times in the same response),
   passing each one the file path and the full file content above (and, for
   code-quality-analyzer, the local temp path if one is given).
2. Wait for all three to complete.
3. Compile their three structured outputs into one combined JSON object.

Return structured JSON matching exactly:
{
  "file": "${file.path}",
  "codeQuality": <code-quality-analyzer's structured output>,
  "testCoverage": <test-coverage-analyzer's structured output>,
  "refactorings": <refactoring-suggester's structured output>
}`;
}
