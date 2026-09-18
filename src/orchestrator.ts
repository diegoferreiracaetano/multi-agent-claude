import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { ReviewReport, ReviewReportSchema, FileReview, FileReviewSchema, FileReviewJSONSchema } from './types/report-types.js';
import { mcpServersConfig } from './config/mcp.config.js';
import { codeQualityAnalyzer, testCoverageAnalyzer, refactoringSuggester } from './agents/index.js';
import { buildFetchFilesPrompt, buildFileReviewPrompt, ReviewablePRFile } from './prompts/orchestrator.prompt.js';
import { RateLimiter, RateLimiterConfig, ReviewError, ErrorCodes, withRetry, withTimeout, formatError, logger } from './utils/index.js';
import { logReviewStart, logReviewComplete, logReviewError } from './utils/logger.js';

const ESLINT_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

const PRFilesResponseSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() }))
});
const PRFilesResponseJSONSchema = (zodToJsonSchema as (s: unknown, options?: unknown) => unknown)(
  PRFilesResponseSchema,
  { $refStrategy: 'root' }
) as Record<string, unknown>;

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  /** Rate limit overrides (defaults: 50 req/min, 100k tokens/min, 5 concurrent) */
  rateLimits?: Partial<RateLimiterConfig>;
  /** Max files to review per PR (keeps cost/time bounded) */
  maxFiles?: number;
  /** Retries for each agent call before giving up */
  maxRetries?: number;
  /** Timeout for the GitHub file-fetch call, in ms */
  fetchTimeoutMs?: number;
  /** Timeout for a single file's 3-subagent review, in ms */
  fileTimeoutMs?: number;
  /** Estimated tokens per subagent call, used for rate limiting */
  estimatedTokensPerFile?: number;
}

async function* generateMessages(userMessage: string, sessionId: string) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content: userMessage },
    parent_tool_use_id: null,
    session_id: sessionId
  };
}

function sanitizeRelativePath(filePath: string): string {
  return filePath
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  private rateLimiter: RateLimiter;
  private maxFiles: number;
  private maxRetries: number;
  private fetchTimeoutMs: number;
  private fileTimeoutMs: number;
  private estimatedTokensPerFile: number;

  constructor(options: OrchestratorOptions = {}) {
    this.rateLimiter = new RateLimiter(options.rateLimits);
    this.maxFiles = options.maxFiles ?? 8;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 60_000;
    this.fileTimeoutMs = options.fileTimeoutMs ?? 120_000;
    this.estimatedTokensPerFile = options.estimatedTokensPerFile ?? 8000;
  }

  /**
   * Current rate limiter status, exposed mainly for testing/observability.
   */
  getRateLimiterStatus() {
    return this.rateLimiter.getStatus();
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    logReviewStart(owner, repo, prNumber);
    const startTime = Date.now();
    const tempDir = path.join(os.tmpdir(), 'code-review-eslint', `${owner}-${repo}-${prNumber}-${startTime}`);

    try {
      const files = await this.fetchFiles(owner, repo, prNumber);

      if (files.length === 0) {
        throw new ReviewError(
          `No reviewable files found in ${owner}/${repo}#${prNumber}`,
          ErrorCodes.FILE_NOT_FOUND,
          { owner, repo, prNumber }
        );
      }

      // Graceful degradation: one file's subagents failing (even after retries)
      // should not sink the whole PR review — skip it and keep the rest.
      const settled = await Promise.allSettled(files.map((file) => this.reviewFile(file, tempDir)));

      const fileReviews: FileReview[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          fileReviews.push(result.value);
        } else {
          logger.warn('Skipping file after review failed', {
            file: files[index]?.path,
            error: formatError(result.reason)
          });
        }
      }

      if (fileReviews.length === 0) {
        throw new ReviewError(
          `All ${files.length} file review(s) failed for ${owner}/${repo}#${prNumber}`,
          ErrorCodes.AGENT_FAILED,
          { owner, repo, prNumber, fileCount: files.length }
        );
      }

      const report = this.buildReport(owner, repo, prNumber, fileReviews, startTime);

      logReviewComplete(owner, repo, prNumber, report.summary.overallScore, report.metadata.duration);
      return report;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(formatError(error));
      logReviewError(owner, repo, prNumber, err);
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Fetch the pull request's reviewable files via the GitHub MCP server.
   */
  private async fetchFiles(owner: string, repo: string, prNumber: number): Promise<ReviewablePRFile[]> {
    await this.rateLimiter.acquire(this.estimatedTokensPerFile);

    try {
      return await withRetry(
        () =>
          withTimeout(
            () => this.runFetchFilesQuery(owner, repo, prNumber),
            this.fetchTimeoutMs,
            `Timed out fetching files for ${owner}/${repo}#${prNumber}`
          ),
        this.maxRetries
      );
    } finally {
      this.rateLimiter.release();
    }
  }

  private async runFetchFilesQuery(owner: string, repo: string, prNumber: number): Promise<ReviewablePRFile[]> {
    const model = process.env.ANTHROPIC_MODEL;
    const prompt = buildFetchFilesPrompt(owner, repo, prNumber, this.maxFiles);

    for await (const message of query({
      prompt: generateMessages(prompt, `fetch-files-${owner}-${repo}-${prNumber}`),
      options: {
        mcpServers: { github: mcpServersConfig.github },
        allowedTools: ['mcp__github__*'],
        model,
        // Headless/CI use: no human is present to approve tool calls, so the
        // session must not block on a permission prompt.
        permissionMode: 'bypassPermissions',
        outputFormat: { type: 'json_schema', schema: PRFilesResponseJSONSchema },
        maxTurns: 15
      }
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        for (const server of message.mcp_servers) {
          if (server.status === 'failed') {
            throw new ReviewError(
              `MCP server '${server.name}' failed to connect`,
              ErrorCodes.GITHUB_API_ERROR,
              { server: server.name }
            );
          }
        }
      }

      if (message.type === 'result') {
        if (message.subtype === 'success' && message.structured_output) {
          const parsed = PRFilesResponseSchema.parse(message.structured_output);
          return parsed.files.slice(0, this.maxFiles);
        }
        throw new ReviewError(
          `Failed to fetch PR files: ${message.subtype}`,
          ErrorCodes.GITHUB_API_ERROR,
          { owner, repo, prNumber, subtype: message.subtype }
        );
      }
    }

    throw new ReviewError('Agent finished without returning structured output', ErrorCodes.GITHUB_API_ERROR, {
      owner,
      repo,
      prNumber
    });
  }

  /**
   * Delegate a single file's review to the 3 subagents (in parallel, via Task tool)
   * and return their combined structured result.
   */
  private async reviewFile(file: ReviewablePRFile, tempDir: string): Promise<FileReview> {
    const tempPath = await this.writeTempFileForLinting(file, tempDir);

    await this.rateLimiter.acquire(this.estimatedTokensPerFile);

    try {
      return await withRetry(
        () =>
          withTimeout(
            () => this.runFileReviewQuery(file, tempPath),
            this.fileTimeoutMs,
            `Timed out reviewing file ${file.path}`
          ),
        this.maxRetries
      );
    } finally {
      this.rateLimiter.release();
    }
  }

  private async writeTempFileForLinting(file: ReviewablePRFile, tempDir: string): Promise<string | undefined> {
    const ext = path.extname(file.path).toLowerCase();
    if (!ESLINT_EXTENSIONS.has(ext)) return undefined;

    try {
      const safeRelativePath = sanitizeRelativePath(file.path);
      const fullPath = path.join(tempDir, safeRelativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, file.content, 'utf-8');
      return fullPath;
    } catch (error) {
      logger.warn('Failed to write temp file for ESLint, continuing without it', {
        file: file.path,
        error: formatError(error)
      });
      return undefined;
    }
  }

  private async runFileReviewQuery(file: ReviewablePRFile, tempPath?: string): Promise<FileReview> {
    const model = process.env.ANTHROPIC_MODEL;
    const prompt = buildFileReviewPrompt(file, tempPath);

    for await (const message of query({
      prompt: generateMessages(prompt, `review-${sanitizeRelativePath(file.path)}`),
      options: {
        agents: {
          'code-quality-analyzer': codeQualityAnalyzer,
          'test-coverage-analyzer': testCoverageAnalyzer,
          'refactoring-suggester': refactoringSuggester
        },
        allowedTools: ['Task'],
        mcpServers: tempPath ? { eslint: mcpServersConfig.eslint } : undefined,
        model,
        permissionMode: 'bypassPermissions',
        // Test coverage analysis (identifying untested paths/edge cases) benefits from
        // extended thinking; this budget is available to all 3 delegated subagents.
        maxThinkingTokens: 4000,
        outputFormat: { type: 'json_schema', schema: FileReviewJSONSchema },
        maxTurns: 25
      }
    })) {
      if (message.type === 'result') {
        if (message.subtype === 'success' && message.structured_output) {
          return FileReviewSchema.parse(message.structured_output);
        }
        throw new ReviewError(
          `Subagent review failed for ${file.path}: ${message.subtype}`,
          ErrorCodes.AGENT_FAILED,
          { file: file.path, subtype: message.subtype }
        );
      }
    }

    throw new ReviewError(
      `Agent finished without returning structured output for ${file.path}`,
      ErrorCodes.STRUCTURED_OUTPUT_FAILED,
      { file: file.path }
    );
  }

  /**
   * Aggregate per-file reviews into the final ReviewReport.
   */
  private buildReport(
    owner: string,
    repo: string,
    prNumber: number,
    fileReviews: FileReview[],
    startTime: number
  ): ReviewReport {
    const criticalIssues = fileReviews.reduce(
      (sum, r) => sum + r.codeQuality.issues.filter((i) => i.severity === 'critical').length,
      0
    );
    const highPriorityTests = fileReviews.reduce(
      (sum, r) =>
        sum + r.testCoverage.untestedPaths.filter((p) => p.priority === 'critical' || p.priority === 'high').length,
      0
    );
    const refactoringOpportunities = fileReviews.reduce((sum, r) => sum + r.refactorings.suggestions.length, 0);
    const overallScore = Math.round(
      fileReviews.reduce((sum, r) => sum + r.codeQuality.overallScore, 0) / fileReviews.length
    );

    const recommendations: ReviewReport['recommendations'] = [];

    for (const review of fileReviews) {
      const criticalOrHigh = review.codeQuality.issues.filter(
        (i) => i.severity === 'critical' || i.severity === 'high'
      );
      if (criticalOrHigh.length > 0) {
        recommendations.push({
          priority: criticalOrHigh.some((i) => i.severity === 'critical') ? 'critical' : 'high',
          category: 'code-quality',
          description: `${criticalOrHigh.length} high/critical issue(s): ${criticalOrHigh[0]?.description ?? ''}`,
          files: [review.file]
        });
      }

      const urgentGaps = review.testCoverage.untestedPaths.filter(
        (p) => p.priority === 'critical' || p.priority === 'high'
      );
      if (urgentGaps.length > 0) {
        recommendations.push({
          priority: urgentGaps.some((p) => p.priority === 'critical') ? 'critical' : 'high',
          category: 'test-coverage',
          description: `${urgentGaps.length} high-priority untested path(s): ${urgentGaps[0]?.reasoning ?? ''}`,
          files: [review.file]
        });
      }

      const highImpactRefactors = review.refactorings.suggestions.filter((s) => s.impact === 'high');
      if (highImpactRefactors.length > 0) {
        recommendations.push({
          priority: 'medium',
          category: 'refactoring',
          description: `${highImpactRefactors.length} high-impact refactor(s): ${highImpactRefactors[0]?.description ?? ''}`,
          files: [review.file]
        });
      }
    }

    const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    recommendations.sort((a, b) => (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99));

    const report: ReviewReport = {
      pullRequest: { owner, repo, number: prNumber },
      fileReviews,
      summary: {
        totalFiles: fileReviews.length,
        overallScore,
        criticalIssues,
        highPriorityTests,
        refactoringOpportunities
      },
      recommendations,
      metadata: {
        analyzedAt: new Date().toISOString(),
        duration: Date.now() - startTime,
        agentVersions: {
          'code-quality-analyzer': process.env.ANTHROPIC_MODEL ?? 'unknown',
          'test-coverage-analyzer': process.env.ANTHROPIC_MODEL ?? 'unknown',
          'refactoring-suggester': process.env.ANTHROPIC_MODEL ?? 'unknown'
        }
      }
    };

    return ReviewReportSchema.parse(report);
  }
}
