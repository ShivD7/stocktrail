import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveText, safeErrorMessage } from '../dist/packages/shared/src/redaction.js';

test('redacts common credential shapes without changing safe diagnostics', () => {
  const shopifyCanary = ['shp', 'at_', '1234567890abcdef'].join('');
  const canaries = [
    'Authorization: ' + ['Bearer', 'private-token-value'].join(' '),
    `X-Shopify-Access-Token=${shopifyCanary}`,
    'client_secret: "do-not-print-this"',
    'password=hunter-two',
    'https://private-user:private-password@example.test/path',
  ];
  const output = redactSensitiveText(canaries.join(' | '));
  for (const fragment of ['private-token-value', 'shpat_', 'do-not-print-this', 'hunter-two', 'private-user', 'private-password']) {
    assert.doesNotMatch(output, new RegExp(fragment, 'i'));
  }
  assert.match(output, /\[REDACTED\]/);
  assert.equal(redactSensitiveText('No Shopify token is stored.'), 'No Shopify token is stored.');
});

test('safeErrorMessage handles Error and non-Error failures', () => {
  assert.equal(safeErrorMessage(new Error('access_token=private-value')), 'access_token=[REDACTED]');
  assert.equal(safeErrorMessage({ secret: 'private-value' }), 'Unexpected error');
});
