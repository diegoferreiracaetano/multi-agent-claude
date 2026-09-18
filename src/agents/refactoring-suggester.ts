import { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { REFACTORING_SUGGESTER_PROMPT } from '../prompts/refactoring-suggester.prompt.js';

export const refactoringSuggester: AgentDefinition = {
  description: 'Suggests modernization and refactoring opportunities with before/after examples',
  prompt: REFACTORING_SUGGESTER_PROMPT,
  tools: ['Skill'],
  model: 'inherit'
};
