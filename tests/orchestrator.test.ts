import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CodeReviewOrchestrator } from '../src/orchestrator.js';
import type { FileReview } from '../src/types/report-types.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn()
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

/**
 * Test doubles for the two message sequences the orchestrator consumes:
 * - the one-shot GitHub file-fetch call (options.mcpServers.github is set)
 * - the per-file review call (options.agents is set, delegates via Task)
 *
 * The mock routes based on the actual `options` passed to query(), and
 * (for file-review calls) on the "FILE PATH: <path>" marker embedded in the
 * generated user message, so multiple files reviewed in parallel each get
 * their own scripted response.
 */
async function readFirstUserMessage(prompt: AsyncGenerator<unknown>): Promise<string> {
  const { value } = await prompt.next();
  const content = (value as { message?: { content?: unknown } })?.message?.content;
  return typeof content === 'string' ? content : '';
}

function makeFileReview(file: string, overrides: Partial<FileReview> = {}): FileReview {
  return {
    file,
    codeQuality: {
      file,
      issues: [],
      overallScore: 90,
      summary: 'Looks fine.'
    },
    testCoverage: {
      file,
      hasTests: true,
      testFiles: [],
      untestedPaths: [],
      coverageEstimate: 80,
      summary: 'Reasonably covered.'
    },
    refactorings: {
      file,
      suggestions: [],
      summary: 'No major refactors needed.'
    },
    ...overrides
  };
}

interface MockScript {
  files: Array<{ path: string; content: string }>;
  reviewsByPath: Record<string, FileReview | 'invalid' | 'error'>;
  fetchFilesShouldFail?: boolean;
}

function installMockQuery(script: MockScript) {
  mockQuery.mockImplementation((params: { prompt: AsyncGenerator<unknown>; options: Record<string, unknown> }) => {
    const { options } = params;

    async function* generator() {
      const userMessage = await readFirstUserMessage(params.prompt);

      // GitHub file-fetch call
      if (options.mcpServers && (options.mcpServers as Record<string, unknown>).github) {
        yield {
          type: 'system',
          subtype: 'init',
          mcp_servers: [{ name: 'github', status: 'connected' }]
        };

        if (script.fetchFilesShouldFail) {
          yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'] };
          return;
        }

        yield {
          type: 'result',
          subtype: 'success',
          structured_output: { files: script.files }
        };
        return;
      }

      // Per-file review call (agents/Task delegation)
      const match = userMessage.match(/FILE PATH: (.+)/);
      const path = match?.[1]?.trim() ?? '';
      const scripted = script.reviewsByPath[path];

      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Task', input: { description: `review ${path}` } }] }
      };

      if (scripted === 'error') {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['agent failed'] };
        return;
      }

      if (scripted === 'invalid') {
        // Missing required fields -> should fail FileReviewSchema.parse()
        yield { type: 'result', subtype: 'success', structured_output: { file: path } };
        return;
      }

      yield {
        type: 'result',
        subtype: 'success',
        structured_output: scripted ?? makeFileReview(path)
      };
    }

    return generator();
  });
}

const FAST_OPTIONS = {
  rateLimits: { maxConcurrent: 20, maxRequestsPerMinute: 1000, maxTokensPerMinute: 10_000_000 },
  maxRetries: 1
};

describe('CodeReviewOrchestrator', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929';
  });

  describe('Configuration', () => {
    it('should initialize with default options', () => {
      const orchestrator = new CodeReviewOrchestrator();
      expect(orchestrator).toBeInstanceOf(CodeReviewOrchestrator);

      const status = orchestrator.getRateLimiterStatus();
      expect(status.availableRequests).toBe(50); // DEFAULT_RATE_LIMITS.maxRequestsPerMinute
      expect(status.availableTokens).toBe(100000); // DEFAULT_RATE_LIMITS.maxTokensPerMinute
    });

    it('should accept custom rate limit configuration', () => {
      const orchestrator = new CodeReviewOrchestrator({
        rateLimits: { maxRequestsPerMinute: 10, maxTokensPerMinute: 5000, maxConcurrent: 2 }
      });

      const status = orchestrator.getRateLimiterStatus();
      expect(status.availableRequests).toBe(10);
      expect(status.availableTokens).toBe(5000);
    });
  });

  describe('reviewPullRequest', () => {
    it('should fetch PR files from GitHub MCP', async () => {
      installMockQuery({
        files: [{ path: 'src/foo.ts', content: 'export const x = 1;' }],
        reviewsByPath: {}
      });

      const orchestrator = new CodeReviewOrchestrator(FAST_OPTIONS);
      const report = await orchestrator.reviewPullRequest('acme', 'widgets', 42);

      expect(report.pullRequest).toEqual({ owner: 'acme', repo: 'widgets', number: 42 });
      expect(report.fileReviews).toHaveLength(1);
      expect(report.fileReviews[0]?.file).toBe('src/foo.ts');

      const fetchCall = mockQuery.mock.calls.find(
        ([params]) => (params.options.mcpServers as Record<string, unknown> | undefined)?.github
      );
      expect(fetchCall).toBeDefined();
      expect(fetchCall![0].options.allowedTools).toContain('mcp__github__*');
    });

    it('should spawn all 3 subagents in parallel', async () => {
      installMockQuery({
        files: [{ path: 'src/foo.ts', content: 'export const x = 1;' }],
        reviewsByPath: {}
      });

      const orchestrator = new CodeReviewOrchestrator(FAST_OPTIONS);
      await orchestrator.reviewPullRequest('acme', 'widgets', 42);

      const reviewCall = mockQuery.mock.calls.find(([params]) => params.options.agents);
      expect(reviewCall).toBeDefined();

      const agentNames = Object.keys(reviewCall![0].options.agents as Record<string, unknown>);
      expect(agentNames.sort()).toEqual(
        ['code-quality-analyzer', 'refactoring-suggester', 'test-coverage-analyzer'].sort()
      );
      expect(reviewCall![0].options.allowedTools).toContain('Task');
    });

    it('should aggregate results into ReviewReport', async () => {
      installMockQuery({
        files: [
          { path: 'src/a.ts', content: 'a' },
          { path: 'src/b.ts', content: 'b' }
        ],
        reviewsByPath: {
          'src/a.ts': makeFileReview('src/a.ts', {
            codeQuality: {
              file: 'src/a.ts',
              issues: [
                { line: 1, severity: 'critical', category: 'security', description: 'sql injection', suggestion: 'parameterize' }
              ],
              overallScore: 40,
              summary: 'Needs work.'
            }
          }),
          'src/b.ts': makeFileReview('src/b.ts', { codeQuality: { file: 'src/b.ts', issues: [], overallScore: 100, summary: 'Great.' } })
        }
      });

      const orchestrator = new CodeReviewOrchestrator(FAST_OPTIONS);
      const report = await orchestrator.reviewPullRequest('acme', 'widgets', 7);

      expect(report.summary.totalFiles).toBe(2);
      expect(report.summary.overallScore).toBe(70); // average of 40 and 100
      expect(report.summary.criticalIssues).toBe(1);
      expect(report.recommendations.some((r) => r.category === 'code-quality')).toBe(true);
    });

    it('should validate output with Zod schema', async () => {
      installMockQuery({
        files: [{ path: 'src/broken.ts', content: 'x' }],
        reviewsByPath: { 'src/broken.ts': 'invalid' }
      });

      const orchestrator = new CodeReviewOrchestrator(FAST_OPTIONS);
      await expect(orchestrator.reviewPullRequest('acme', 'widgets', 1)).rejects.toThrow();
    });

    it('should throw when the GitHub MCP fetch fails', async () => {
      installMockQuery({ files: [], reviewsByPath: {}, fetchFilesShouldFail: true });

      const orchestrator = new CodeReviewOrchestrator(FAST_OPTIONS);
      await expect(orchestrator.reviewPullRequest('acme', 'widgets', 1)).rejects.toThrow();
    });

    it('should throw when there are no reviewable files', async () => {
      installMockQuery({ files: [], reviewsByPath: {} });

      const orchestrator = new CodeReviewOrchestrator(FAST_OPTIONS);
      await expect(orchestrator.reviewPullRequest('acme', 'widgets', 1)).rejects.toThrow(/No reviewable files/);
    });

    it('should exhaust retries and fail when a subagent call keeps failing', async () => {
      installMockQuery({
        files: [{ path: 'src/flaky.ts', content: 'x' }],
        reviewsByPath: { 'src/flaky.ts': 'error' }
      });

      const orchestrator = new CodeReviewOrchestrator({ ...FAST_OPTIONS, maxRetries: 2 });
      await expect(orchestrator.reviewPullRequest('acme', 'widgets', 1)).rejects.toThrow();
    });

    it('should gracefully degrade: skip a failing file but still return reviews for the rest', async () => {
      installMockQuery({
        files: [
          { path: 'src/good.ts', content: 'ok' },
          { path: 'src/flaky.ts', content: 'x' }
        ],
        reviewsByPath: {
          'src/good.ts': makeFileReview('src/good.ts'),
          'src/flaky.ts': 'error'
        }
      });

      const orchestrator = new CodeReviewOrchestrator(FAST_OPTIONS);
      const report = await orchestrator.reviewPullRequest('acme', 'widgets', 1);

      expect(report.fileReviews).toHaveLength(1);
      expect(report.fileReviews[0]?.file).toBe('src/good.ts');
      expect(report.summary.totalFiles).toBe(1);
    });
  });

  describe('Integration', () => {
    // These tests require actual API keys and should be skipped in CI
    it.skip('should review a real small PR', async () => {
      // NOTE: Only run manually with valid API keys (unset the mock above to hit the real SDK).
      const orchestrator = new CodeReviewOrchestrator({ maxFiles: 2 });
      const report = await orchestrator.reviewPullRequest('octocat', 'Hello-World', 1);
      expect(report.fileReviews.length).toBeGreaterThan(0);
    });
  });
});
