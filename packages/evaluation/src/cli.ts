import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateRuleCorpus, renderEvaluationReport } from './index.js';

async function main(): Promise<void> {
  const [manifestPath, ...extra] = process.argv.slice(2);
  if (manifestPath === undefined || extra.length > 0) {
    throw new Error('Usage: node dist/packages/evaluation/src/cli.js <rule-cases.json>');
  }
  const input: unknown = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  process.stdout.write(renderEvaluationReport(evaluateRuleCorpus(input)));
}

main().catch(() => {
  console.error('StockTrail evaluation failed. Check the synthetic corpus path and schema.');
  process.exitCode = 1;
});
