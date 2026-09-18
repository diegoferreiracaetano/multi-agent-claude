import * as dotenv from 'dotenv';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator, formatError } from './utils/index.js';

// Load environment variables
dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
async function main() {
  const [owner, repo, prStr] = process.argv.slice(2);

  if (!owner || !repo || !prStr) {
    console.error('Usage: npm run dev <owner> <repo> <pr-number>');
    process.exit(1);
  }

  const prNumber = Number(prStr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`Invalid PR number: "${prStr}" (must be a positive integer)`);
    process.exit(1);
  }

  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasBedrockCreds = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  if (hasBedrockCreds) {
    if (!process.env.AWS_REGION) {
      console.error('AWS_REGION is required when using AWS Bedrock authentication.');
      process.exit(1);
    }
    console.log('🔐 Using AWS Bedrock authentication');
  } else if (hasAnthropicKey) {
    console.log('🔐 Using Anthropic API authentication');
  } else {
    console.error(
      'No authentication configured. Set ONE of:\n' +
        '  - ANTHROPIC_API_KEY (Anthropic API), or\n' +
        '  - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION (AWS Bedrock)'
    );
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_MODEL) {
    console.error(
      'ANTHROPIC_MODEL is required. Examples:\n' +
        '  - Anthropic API: claude-sonnet-4-5-20250929\n' +
        '  - AWS Bedrock: us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    );
    process.exit(1);
  }

  try {
    const orchestrator = new CodeReviewOrchestrator();
    const report = await orchestrator.reviewPullRequest(owner, repo, prNumber);

    const reportGenerator = new ReportGenerator();
    const reportsDir = path.join(process.cwd(), 'reports');
    await fs.mkdir(reportsDir, { recursive: true });

    const baseName = `${owner}-${repo}-${prNumber}`;
    await Promise.all([
      fs.writeFile(path.join(reportsDir, `${baseName}.md`), reportGenerator.generateMarkdownReport(report)),
      fs.writeFile(path.join(reportsDir, `${baseName}.html`), reportGenerator.generateHTMLReport(report)),
      fs.writeFile(path.join(reportsDir, `${baseName}.json`), reportGenerator.generateJSONReport(report))
    ]);

    console.log(`✅ Review complete. Reports written to ${reportsDir}/${baseName}.{md,html,json}`);
    console.log(`   Overall score: ${report.summary.overallScore}/100 across ${report.summary.totalFiles} file(s)`);
  } catch (error) {
    console.error('Error:', formatError(error));
    process.exit(1);
  }
}

main();
