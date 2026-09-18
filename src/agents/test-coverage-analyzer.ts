import { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_COVERAGE_ANALYZER_PROMPT } from '../prompts/test-coverage-analyzer.prompt.js';

export const testCoverageAnalyzer: AgentDefinition = {
  description: 'Identifies untested code paths and prioritizes what needs test coverage',
  prompt: TEST_COVERAGE_ANALYZER_PROMPT,
  tools: ['Skill'],
  model: 'inherit'
};
