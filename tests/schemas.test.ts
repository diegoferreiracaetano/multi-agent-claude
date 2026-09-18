import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  CodeQualityResultSchema,
  CodeQualityResultJSONSchema,
  TestCoverageResultSchema,
  TestCoverageResultJSONSchema,
  RefactoringSuggestionSchema,
  RefactoringSuggestionJSONSchema
} from '../src/types/analysis-results.js';
import { ReviewReportSchema, ReviewReportJSONSchema, FileReviewSchema } from '../src/types/report-types.js';

describe('CodeQualityResultSchema', () => {
  it('accepts a valid, fully-populated result', () => {
    const valid = {
      file: 'src/foo.ts',
      issues: [
        {
          line: 42,
          severity: 'high',
          category: 'security',
          description: 'Hardcoded secret',
          suggestion: 'Move to an environment variable'
        }
      ],
      overallScore: 85,
      summary: 'A few issues found.'
    };
    expect(() => CodeQualityResultSchema.parse(valid)).not.toThrow();
  });

  it('accepts an empty issues array (clean file)', () => {
    const valid = { file: 'src/clean.ts', issues: [], overallScore: 100, summary: 'No issues found.' };
    expect(() => CodeQualityResultSchema.parse(valid)).not.toThrow();
  });

  it('accepts overallScore at both boundary values (0 and 100)', () => {
    const base = { file: 'src/x.ts', issues: [], summary: 's' };
    expect(() => CodeQualityResultSchema.parse({ ...base, overallScore: 0 })).not.toThrow();
    expect(() => CodeQualityResultSchema.parse({ ...base, overallScore: 100 })).not.toThrow();
  });

  it('rejects overallScore outside the 0-100 range', () => {
    const base = { file: 'src/x.ts', issues: [], summary: 's' };
    expect(() => CodeQualityResultSchema.parse({ ...base, overallScore: -1 })).toThrow(z.ZodError);
    expect(() => CodeQualityResultSchema.parse({ ...base, overallScore: 101 })).toThrow(z.ZodError);
  });

  it('rejects an invalid severity enum value', () => {
    const invalid = {
      file: 'src/foo.ts',
      issues: [{ line: 1, severity: 'catastrophic', category: 'security', description: 'x', suggestion: 'y' }],
      overallScore: 50,
      summary: 's'
    };
    expect(() => CodeQualityResultSchema.parse(invalid)).toThrow(z.ZodError);
  });

  it('rejects a missing required field', () => {
    const invalid = { file: 'src/foo.ts', issues: [], summary: 'missing overallScore' };
    expect(() => CodeQualityResultSchema.parse(invalid)).toThrow(z.ZodError);
  });

  it('rejects wrong types on required fields', () => {
    const invalid = { file: 'src/foo.ts', issues: [], overallScore: '85', summary: 's' };
    expect(() => CodeQualityResultSchema.parse(invalid)).toThrow(z.ZodError);
  });
});

describe('TestCoverageResultSchema', () => {
  it('accepts a valid result with untested paths', () => {
    const valid = {
      file: 'src/foo.ts',
      hasTests: false,
      testFiles: [],
      untestedPaths: [
        {
          type: 'function',
          location: 'parseInput()',
          priority: 'high',
          reasoning: 'No test covers the error branch',
          suggestedTest: 'Assert it throws on malformed input'
        }
      ],
      coverageEstimate: 40,
      summary: 'Low coverage.'
    };
    expect(() => TestCoverageResultSchema.parse(valid)).not.toThrow();
  });

  it('accepts an empty untestedPaths array (fully covered file)', () => {
    const valid = {
      file: 'src/foo.ts',
      hasTests: true,
      testFiles: ['src/foo.test.ts'],
      untestedPaths: [],
      coverageEstimate: 100,
      summary: 'Fully covered.'
    };
    expect(() => TestCoverageResultSchema.parse(valid)).not.toThrow();
  });

  it('accepts coverageEstimate at both boundary values (0 and 100)', () => {
    const base = { file: 'src/x.ts', hasTests: false, testFiles: [], untestedPaths: [], summary: 's' };
    expect(() => TestCoverageResultSchema.parse({ ...base, coverageEstimate: 0 })).not.toThrow();
    expect(() => TestCoverageResultSchema.parse({ ...base, coverageEstimate: 100 })).not.toThrow();
  });

  it('rejects an invalid priority enum value', () => {
    const invalid = {
      file: 'src/foo.ts',
      hasTests: false,
      testFiles: [],
      untestedPaths: [{ type: 'function', location: 'x()', priority: 'urgent', reasoning: 'r', suggestedTest: 't' }],
      coverageEstimate: 50,
      summary: 's'
    };
    expect(() => TestCoverageResultSchema.parse(invalid)).toThrow(z.ZodError);
  });

  it('rejects hasTests as a non-boolean', () => {
    const invalid = {
      file: 'src/foo.ts',
      hasTests: 'yes',
      testFiles: [],
      untestedPaths: [],
      coverageEstimate: 50,
      summary: 's'
    };
    expect(() => TestCoverageResultSchema.parse(invalid)).toThrow(z.ZodError);
  });
});

describe('RefactoringSuggestionSchema', () => {
  it('accepts a valid result with suggestions', () => {
    const valid = {
      file: 'src/foo.ts',
      suggestions: [
        {
          type: 'extract-function',
          location: 'lines 10-40',
          impact: 'medium',
          description: 'Duplicated validation logic',
          before: 'if (a) { ... } if (b) { ... same ... }',
          after: 'function validate(x) { ... }',
          benefits: 'Removes duplication'
        }
      ],
      summary: 'One extraction opportunity.'
    };
    expect(() => RefactoringSuggestionSchema.parse(valid)).not.toThrow();
  });

  it('accepts an empty suggestions array', () => {
    const valid = { file: 'src/clean.ts', suggestions: [], summary: 'No refactors needed.' };
    expect(() => RefactoringSuggestionSchema.parse(valid)).not.toThrow();
  });

  it('rejects an invalid type enum value', () => {
    const invalid = {
      file: 'src/foo.ts',
      suggestions: [
        { type: 'rewrite-everything', location: 'x', impact: 'low', description: 'd', before: 'b', after: 'a', benefits: 'x' }
      ],
      summary: 's'
    };
    expect(() => RefactoringSuggestionSchema.parse(invalid)).toThrow(z.ZodError);
  });

  it('rejects a missing required field inside a suggestion', () => {
    const invalid = {
      file: 'src/foo.ts',
      suggestions: [{ type: 'simplify', location: 'x', impact: 'low', description: 'd', before: 'b' }],
      summary: 's'
    };
    expect(() => RefactoringSuggestionSchema.parse(invalid)).toThrow(z.ZodError);
  });
});

describe('FileReviewSchema and ReviewReportSchema (aggregate)', () => {
  const validFileReview = {
    file: 'src/foo.ts',
    codeQuality: { file: 'src/foo.ts', issues: [], overallScore: 90, summary: 's' },
    testCoverage: { file: 'src/foo.ts', hasTests: true, testFiles: [], untestedPaths: [], coverageEstimate: 80, summary: 's' },
    refactorings: { file: 'src/foo.ts', suggestions: [], summary: 's' }
  };

  it('accepts a valid combined FileReview', () => {
    expect(() => FileReviewSchema.parse(validFileReview)).not.toThrow();
  });

  it('rejects a FileReview missing one of the three sub-results', () => {
    const { testCoverage: _drop, ...invalid } = validFileReview;
    expect(() => FileReviewSchema.parse(invalid)).toThrow(z.ZodError);
  });

  it('accepts a valid, fully-populated ReviewReport with an empty fileReviews array', () => {
    const valid = {
      pullRequest: { owner: 'octocat', repo: 'Hello-World', number: 1 },
      fileReviews: [],
      summary: { totalFiles: 0, overallScore: 0, criticalIssues: 0, highPriorityTests: 0, refactoringOpportunities: 0 },
      recommendations: [],
      metadata: { analyzedAt: new Date().toISOString(), duration: 1200, agentVersions: { orchestrator: 'claude-sonnet-4-5-20250929' } }
    };
    expect(() => ReviewReportSchema.parse(valid)).not.toThrow();
  });

  it('accepts a ReviewReport with a populated fileReviews array and recommendations', () => {
    const valid = {
      pullRequest: { owner: 'octocat', repo: 'Hello-World', number: 1 },
      fileReviews: [validFileReview],
      summary: { totalFiles: 1, overallScore: 90, criticalIssues: 0, highPriorityTests: 0, refactoringOpportunities: 0 },
      recommendations: [{ priority: 'low', category: 'style', description: 'Minor nit', files: ['src/foo.ts'] }],
      metadata: { analyzedAt: new Date().toISOString(), duration: 1200, agentVersions: {} }
    };
    expect(() => ReviewReportSchema.parse(valid)).not.toThrow();
  });

  it('rejects a ReviewReport with an invalid recommendation priority', () => {
    const invalid = {
      pullRequest: { owner: 'octocat', repo: 'Hello-World', number: 1 },
      fileReviews: [],
      summary: { totalFiles: 0, overallScore: 0, criticalIssues: 0, highPriorityTests: 0, refactoringOpportunities: 0 },
      recommendations: [{ priority: 'urgent', category: 'style', description: 'd', files: [] }],
      metadata: { analyzedAt: new Date().toISOString(), duration: 1200, agentVersions: {} }
    };
    expect(() => ReviewReportSchema.parse(invalid)).toThrow(z.ZodError);
  });

  it('rejects a ReviewReport missing the pullRequest block', () => {
    const invalid = {
      fileReviews: [],
      summary: { totalFiles: 0, overallScore: 0, criticalIssues: 0, highPriorityTests: 0, refactoringOpportunities: 0 },
      recommendations: [],
      metadata: { analyzedAt: new Date().toISOString(), duration: 1200, agentVersions: {} }
    };
    expect(() => ReviewReportSchema.parse(invalid)).toThrow(z.ZodError);
  });
});

describe('JSON Schema export for SDK structured outputs', () => {
  it('CodeQualityResultJSONSchema is a valid-shaped JSON Schema with the expected required fields', () => {
    const schema = CodeQualityResultJSONSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.required).toEqual(expect.arrayContaining(['file', 'issues', 'overallScore', 'summary']));
  });

  it('TestCoverageResultJSONSchema declares the expected required fields', () => {
    const schema = TestCoverageResultJSONSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(
      expect.arrayContaining(['file', 'hasTests', 'testFiles', 'untestedPaths', 'coverageEstimate', 'summary'])
    );
  });

  it('RefactoringSuggestionJSONSchema declares the expected required fields', () => {
    const schema = RefactoringSuggestionJSONSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(expect.arrayContaining(['file', 'suggestions', 'summary']));
  });

  it('ReviewReportJSONSchema declares the top-level required fields and has no unresolved $ref', () => {
    const schema = ReviewReportJSONSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(
      expect.arrayContaining(['pullRequest', 'fileReviews', 'summary', 'recommendations', 'metadata'])
    );
    // $refStrategy: 'root' should inline definitions rather than leaving a bare $ref at the top level.
    expect(schema.$ref).toBeUndefined();
  });
});
