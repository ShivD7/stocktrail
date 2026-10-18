import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardActions, DashboardActionError } from '../dist/packages/agent/src/dashboard-actions.js';

const shop = 'example.myshopify.com';
const productId = 'gid://shopify/Product/9000';
const incidentId = '11111111-1111-4111-8111-111111111111';
const proposalId = '22222222-2222-4222-8222-222222222222';

function dependencies(repository, overrides = {}) {
  const unused = async name => { throw new Error(`unexpected dependency: ${name}`); };
  return {
    async openRepository() { return repository; },
    importCatalog: () => unused('importCatalog'), monitor: () => unused('monitor'), scan: () => unused('scan'),
    improve: () => unused('improve'), list: () => unused('list'), status: () => unused('status'),
    details: () => unused('details'), reject: () => unused('reject'), apply: () => unused('apply'),
    reconcile: () => unused('reconcile'), revert: () => unused('revert'), rerun: () => unused('rerun'),
    ...overrides,
  };
}

function scopedRepository({ proposal = true, product = true, incident = true } = {}) {
  return {
    dashboardProduct(requestedShop, requestedProduct) {
      assert.equal(requestedShop, shop); assert.equal(requestedProduct, productId);
      return product ? {} : null;
    },
    dashboardIncident(requestedShop, requestedIncident) {
      assert.equal(requestedShop, shop); assert.equal(requestedIncident, incidentId);
      return incident ? {} : null;
    },
    getProposalForShop(requestedShop, requestedProposal) {
      assert.equal(requestedShop, shop); assert.equal(requestedProposal, proposalId);
      return proposal ? { id: proposalId } : null;
    },
    close() {},
  };
}

test('dashboard actions enforce shop scope before reading proposal artifacts', async () => {
  let detailsCalled = false;
  const actions = createDashboardActions('unused', shop, dependencies(scopedRepository({ proposal: false }), {
    async details() { detailsCalled = true; throw new Error('must not read artifact'); },
  }));
  await assert.rejects(actions.proposal(proposalId), error => {
    assert.ok(error instanceof DashboardActionError);
    assert.equal(error.code, 'not_found');
    assert.equal(error.status, 404);
    return true;
  });
  assert.equal(detailsCalled, false);
});

test('dashboard actions keep guidance-only improve results and target one incident rerun', async () => {
  let rerunArgs;
  const actions = createDashboardActions('unused', shop, dependencies(scopedRepository(), {
    async improve() { return { proposal: null, guidanceCodes: ['PV_NO_EFFECT'] }; },
    async rerun(directory, requestedShop, requestedIncident) {
      rerunArgs = { directory, requestedShop, requestedIncident };
      return { summary: { id: '33333333-3333-4333-8333-333333333333', status: 'passed', passed: 1, failed: 0, inconclusive: 0 }, executions: [] };
    },
  }));
  assert.deepEqual(await actions.improve(productId), { proposalId: null, guidanceCodes: ['PV_NO_EFFECT'] });
  assert.deepEqual(await actions.rerun(incidentId), { status: 'passed', passed: 1, failed: 0, inconclusive: 0 });
  assert.deepEqual(rerunArgs, { directory: 'unused', requestedShop: shop, requestedIncident: incidentId });
});

test('dashboard apply maps confirmation, warning, scope, conflict, and integrity failures to stable errors', async () => {
  const cases = [
    ['Approval must exactly match APPLY id', 'confirmation_mismatch', 422],
    ['safety warnings require acknowledgement', 'warning_acknowledgement_required', 422],
    ['write_products scope missing', 'write_scope_required', 403],
    ['proposal is not ready', 'conflict', 409],
    ['proposal artifact hash mismatch', 'artifact_integrity_failed', 500],
  ];
  for (const [message, code, status] of cases) {
    const actions = createDashboardActions('unused', shop, dependencies(scopedRepository(), {
      async apply() { throw new Error(message); },
    }));
    await assert.rejects(actions.apply(proposalId, { confirmation: 'APPLY', acknowledgeWarnings: false }), error => {
      assert.ok(error instanceof DashboardActionError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      return true;
    });
  }
});
