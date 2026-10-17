import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { formatProposalPreview } from '../dist/apps/cli/src/proposal-output.js';

async function cli(args) {
  const child = spawn(process.execPath, ['dist/apps/cli/src/index.js', ...args], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STOCKTRAIL_HOME: '' },
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

test('help exposes explicit proposal workflow without force or yes shortcuts', async () => {
  const result = await cli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /improve --product-id/);
  assert.match(result.stdout, /proposal status/);
  assert.match(result.stdout, /apply <proposal-id>/);
  assert.match(result.stdout, /revert <applied-proposal-id>/);
  assert.doesNotMatch(result.stdout, /--yes|--force/);
});

test('noninteractive approval token must exactly match before local or network work', async () => {
  const proposalId = '22222222-2222-4222-8222-222222222222';
  const result = await cli(['apply', proposalId, '--approve', '33333333-3333-4333-8333-333333333333']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--approve must exactly equal/);
  assert.doesNotMatch(result.stderr, /token|header|request.?id/i);
});

test('terminal proposal preview escapes control sequences', () => {
  const proposal = {
    id: '22222222-2222-4222-8222-222222222222', kind: 'improvement', productId: 'gid://shopify/Product/1',
    sourceEvidenceRunId: '11111111-1111-4111-8111-111111111111',
    currentReadiness: { total: 75 }, predictedReadiness: { total: 100 },
    validation: { warningCodes: [] },
    changes: [{ field: 'title', before: 'Safe\u001b]0;private\u0007', after: 'Safe', }],
  };
  const output = formatProposalPreview(proposal).join('\n');
  assert.doesNotMatch(output, /\u001b\]0;/u);
  assert.match(output, /\\u001b/);
  assert.match(output, /\\u0007/);
});
