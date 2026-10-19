import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const incidentId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const proposalId = '33333333-3333-4333-8333-333333333333';
const revertId = '44444444-4444-4444-8444-444444444444';
const productId = 'gid://shopify/Product/9000';
const timestamp = '2026-10-16T12:00:00.000Z';
const dashboardRoot = resolve('dist/apps/dashboard/client');

const product = {
  productGid: productId, title: 'Synthetic product with a deliberately long responsive title', status: 'ACTIVE', present: true,
  monitored: true, variantCount: 1, inventory: { sellableVariants: 0, unavailableVariants: 1, unknownVariants: 0 },
  latestScan: { id: runId, status: 'complete', completedAt: timestamp }, readinessScore: 70,
  weakestComponent: { id: 'availability_agreement', outcome: 'not_ready', points: 0, weight: 30 },
  openIncidentCount: 1, latestProposal: { id: proposalId, kind: 'improvement', status: 'ready', verificationStatus: 'not_started', createdAt: timestamp },
  allowedActions: ['unmonitor', 'scan', 'improve'],
};

const incident = {
  id: incidentId, productGid: productId, productTitle: product.title, variantGid: 'gid://shopify/ProductVariant/9001',
  variantLabel: 'Size: One', ruleId: 'ST-001', status: 'open', severity: 'medium', firstSeenAt: timestamp,
  lastSeenAt: timestamp, lastEvaluatedAt: timestamp, occurrenceCount: 1, latestReasonCode: 'synthetic_failure',
};

function proposal(applied) {
  return {
    id: proposalId, productGid: productId, kind: 'improvement', parentProposalId: null,
    status: applied ? 'applied' : 'ready', verificationStatus: applied ? 'verified' : 'not_started',
    sourceEvidenceRunId: runId, verificationEvidenceRunId: applied ? runId : null,
    changes: [{ field: 'title', before: '<b>Old title</b>', after: '<script>New title</script>', beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64), displayMode: 'text' }],
    diffs: [{ field: 'title', mode: 'word', parts: [{ kind: 'remove', value: '<b>Old title</b>' }, { kind: 'add', value: '<script>New title</script>' }], truncated: false }],
    validation: { valid: true, reasonCodes: [], warningCodes: ['PW_TRANSIENT_CLAIM_REINTRODUCED'] },
    scores: { current: 70, predicted: 100, verified: applied ? 100 : null }, createdAt: timestamp,
    completedAt: applied ? timestamp : null, allowedActions: applied ? ['create_revert'] : ['reject', 'apply'],
  };
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function startSyntheticDashboard() {
  let applied = false;
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/api/overview') {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 400));
      return json(response, {
        shop: 'example.myshopify.com', monitoredProducts: { selected: 1, active: 1, limit: 10 },
        incidents: { open: 1, resolved: 0, ignored: 0 },
        latestScan: { id: runId, productGid: productId, productTitle: product.title, status: 'complete', completedAt: timestamp, readinessScore: 70 },
        scoreDistribution: { buckets: [{ minimum: 0, maximum: 19, count: 0 }, { minimum: 20, maximum: 39, count: 0 }, { minimum: 40, maximum: 59, count: 0 }, { minimum: 60, maximum: 79, count: 1 }, { minimum: 80, maximum: 100, count: 0 }], inconclusive: 0 },
      });
    }
    if (url.pathname === '/api/products') return json(response, [product]);
    if (url.pathname === `/api/products/${encodeURIComponent(productId)}`) return json(response, { ...product, productUrl: 'https://example.invalid/products/synthetic', descriptionText: 'Synthetic', seo: { title: null, description: null }, readiness: null });
    if (url.pathname === '/api/incidents') return json(response, [incident]);
    if (url.pathname === '/api/connection') return json(response, {
      shop: 'example.myshopify.com', configuration: 'ready', credentialStorage: 'stored',
      catalog: { products: 1, variants: 1, imports: 1 }, monitoring: { selected: 1, active: 1, limit: 10 },
      localData: { evidenceRuns: 1, incidents: 1, testRuns: 1, retention: 'manual' },
    });
    if (url.pathname === `/api/incidents/${incidentId}`) return json(response, {
      ...incident, productUrl: 'https://example.invalid/products/synthetic', latestEvidenceRunId: runId,
      sources: [{ source: 'jsonld', outcome: 'observed', reasonCode: null, itemCount: 1, artifactPath: 'jsonld.json' }],
      comparison: [
        { perspective: 'admin', source: 'admin', outcome: 'observed', reasonCode: null, itemCount: 1 },
        { perspective: 'storefront', source: 'ajax', outcome: 'inconclusive', reasonCode: 'missing', itemCount: 0 },
        { perspective: 'search', source: 'jsonld', outcome: 'observed', reasonCode: null, itemCount: 1 },
      ], testHistory: [],
    });
    if (url.pathname === `/api/incidents/${incidentId}/rerun` && request.method === 'POST') return json(response, { status: 'passed', passed: 1, failed: 0, inconclusive: 0 });
    if (url.pathname === `/api/proposals/${proposalId}` && request.method === 'GET') return json(response, proposal(applied));
    if (url.pathname === `/api/proposals/${proposalId}/apply` && request.method === 'POST') {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
      applied = true;
      return json(response, { proposalId, status: 'applied', verification: 'verified', diagnosticOutcome: 'pass', changedFields: ['title'] });
    }
    if (url.pathname === `/api/proposals/${proposalId}/revert` && request.method === 'POST') return json(response, { proposalId: revertId, parentProposalId: proposalId, status: 'ready', warningCodes: [] });

    const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(dashboardRoot, requested));
    const relativeFile = relative(dashboardRoot, file);
    if (relativeFile.startsWith('..') || isAbsolute(relativeFile)) return json(response, { error: 'not_found' }, 404);
    try {
      const body = await readFile(file);
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      json(response, { error: 'not_found' }, 404);
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  };
}

async function launchInstalledChromium(testContext) {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    const candidates = [
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ].filter(Boolean);
    for (const executablePath of candidates) {
      if (!existsSync(executablePath)) continue;
      try { return await chromium.launch({ headless: true, executablePath }); } catch { /* Try the next installed browser. */ }
    }
    testContext.skip('No installed Chromium executable is available for Playwright QA.');
    return null;
  }
}

test('dashboard keyboard, dialog, inert preview, reduced motion, and responsive layouts', async testContext => {
  const synthetic = await startSyntheticDashboard();
  const browser = await launchInstalledChromium(testContext);
  if (!browser) { await synthetic.close(); return; }
  const context = await browser.newContext({ viewport: { width: 375, height: 780 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const externalRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url());
  });
  try {
    await page.goto(`${synthetic.url}/#/`);
    const loader = page.locator('.loader');
    await loader.waitFor({ state: 'visible' });
    const reducedDuration = await loader.evaluate(element => getComputedStyle(element).animationDuration);
    const reducedDurationMs = reducedDuration.endsWith('ms') ? Number.parseFloat(reducedDuration) : Number.parseFloat(reducedDuration) * 1000;
    assert.ok(reducedDurationMs <= 0.01, `expected reduced animation duration, received ${reducedDuration}`);
    await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();
    assert.equal(await page.title(), 'Overview · StockTrail');
    const skipLink = page.getByRole('link', { name: 'Skip to content' });
    await skipLink.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#main-content').evaluate(element => element === document.activeElement), true);
    assert.equal(new URL(page.url()).hash, '#/');

    for (const width of [320, 375, 1440]) {
      await page.setViewportSize({ width, height: width < 500 ? 780 : 900 });
      for (const route of ['#/', '#/products', `#/products/${encodeURIComponent(productId)}`, '#/incidents', `#/incidents/${incidentId}`, `#/proposals/${proposalId}`, '#/connection']) {
        await page.goto(`${synthetic.url}/${route}`);
        await page.getByRole('heading', { level: 1 }).waitFor();
        await page.waitForTimeout(25);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}px ${route} overflowed horizontally`);
      }
    }

    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(`${synthetic.url}/#/proposals/${proposalId}`);
    const proposalHeading = page.getByRole('heading', { name: 'Improvement proposal', level: 1 });
    await proposalHeading.waitFor();
    assert.equal(await page.title(), 'Improvement proposal · StockTrail');
    assert.equal(await proposalHeading.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('.semantic-diff del').textContent(), '<b>Old title</b>');
    assert.equal(await page.locator('.semantic-diff ins').textContent(), '<script>New title</script>');
    assert.equal(await page.locator('.semantic-diff b, .semantic-diff script').count(), 0);

    const trigger = page.getByRole('button', { name: 'Review and apply' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Apply to Shopify' });
    await dialog.waitFor();
    assert.equal(await page.locator('.sidebar').getAttribute('inert'), '');
    const confirmationInput = dialog.getByRole('textbox');
    assert.equal(await confirmationInput.evaluate(element => element === document.activeElement), true);

    const dialogClose = dialog.getByRole('button', { name: 'Close confirmation' });
    await dialogClose.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await dialogClose.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);

    await trigger.click();
    const reopened = page.getByRole('dialog', { name: 'Apply to Shopify' });
    const input = reopened.getByRole('textbox');
    const submit = reopened.getByRole('button', { name: 'Apply proposal' });
    await input.fill(`APPLY ${proposalId.slice(0, -1)}0`);
    await reopened.getByRole('checkbox').check();
    assert.equal(await submit.isDisabled(), true);
    await input.fill(`APPLY ${proposalId}`);
    assert.equal(await submit.isEnabled(), true);
    await submit.click();
    assert.equal(await reopened.getAttribute('aria-busy'), 'true');
    await reopened.getByRole('status').filter({ hasText: 'Apply result: applied; verification verified.' }).waitFor();
    const completionClose = reopened.getByRole('button', { name: 'Close', exact: true });
    assert.equal(await completionClose.evaluate(element => element === document.activeElement), true);
    await page.getByRole('button', { name: 'Create revert' }).waitFor();
    await completionClose.click();
    assert.equal(await proposalHeading.evaluate(element => element === document.activeElement), true);

    await page.goto(`${synthetic.url}/#/incidents/${incidentId}`);
    const incidentHeading = page.getByRole('heading', { name: 'Search data overpromises availability', level: 1 });
    await incidentHeading.waitFor();
    assert.equal(await page.title(), 'ST-001 · Incident · StockTrail');
    assert.equal(await incidentHeading.evaluate(element => element === document.activeElement), true);
    const rerun = page.getByRole('button', { name: /Rerun test/ });
    await rerun.click();
    await page.getByRole('status').filter({ hasText: '1 passed, 0 failed, 0 inconclusive.' }).waitFor();
    assert.equal(synthetic.requests.filter(path => path === `/api/proposals/${proposalId}/apply`).length, 1);
    assert.deepEqual(externalRequests, []);
  } finally {
    await context.close();
    await browser.close();
    await synthetic.close();
  }
});
