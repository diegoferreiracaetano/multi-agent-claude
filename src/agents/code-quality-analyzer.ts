import { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { CODE_QUALITY_ANALYZER_PROMPT } from '../prompts/code-quality-analyzer.prompt.js';
import { eslintTools } from '../config/mcp.config.js';

export const codeQualityAnalyzer: AgentDefinition = {
  description: 'Security, performance, and maintainability code review specialist',
  prompt: CODE_QUALITY_ANALYZER_PROMPT,
  tools: ['Skill', ...eslintTools],
  model: 'inherit'
};
