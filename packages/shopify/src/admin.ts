import { normalizeShop } from '../../agent/src/config.js';

export const SHOPIFY_API_VERSION = '2026-10';
export const REQUIRED_ACCESS_SCOPES = ['read_products', 'read_inventory'] as const;

const verificationQuery = `#graphql
  query VerifyStockTrailConnection {
    shop {
      name
      myshopifyDomain
    }
    currentAppInstallation {
      accessScopes {
        handle
      }
    }
  }
`;

export type ShopifyConnection = {
  shopName: string;
  shopDomain: string;
  grantedScopes: string[];
};

type Fetch = typeof globalThis.fetch;

type VerificationPayload = {
  data?: {
    shop?: { name?: unknown; myshopifyDomain?: unknown };
    currentAppInstallation?: { accessScopes?: Array<{ handle?: unknown }> };
  };
  errors?: Array<{ message?: unknown; extensions?: { code?: unknown } }>;
};

function grantsReadAccess(scopes: Set<string>, requiredScope: string): boolean {
  return scopes.has(requiredScope) || scopes.has(requiredScope.replace(/^read_/, 'write_'));
}

export async function verifyShopifyToken(
  shopInput: string,
  tokenInput: string,
  fetcher: Fetch = globalThis.fetch,
): Promise<ShopifyConnection> {
  const shop = normalizeShop(shopInput);
  const token = tokenInput.trim();
  if (!token) throw new Error('The Shopify Admin API token cannot be empty.');

  let response: Response;
  try {
    response = await fetcher(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query: verificationQuery }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Shopify did not respond while verifying ${shop}.`);
    }
    throw new Error(`Could not reach Shopify to verify ${shop}. Check the shop hostname and your connection.`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error('Shopify rejected the token. Check that it is valid for this store and has not been revoked.');
  }
  if (!response.ok) {
    throw new Error(`Shopify token verification failed with HTTP ${response.status}.`);
  }

  let payload: VerificationPayload;
  try {
    payload = await response.json() as VerificationPayload;
  } catch {
    throw new Error('Shopify returned an unreadable response while verifying the token.');
  }

  if (payload.errors?.length) {
    const denied = payload.errors.some(error => error.extensions?.code === 'ACCESS_DENIED');
    throw new Error(denied
      ? 'The token is valid but cannot read the app installation or shop details.'
      : 'Shopify rejected the token verification query.');
  }

  const name = payload.data?.shop?.name;
  const domain = payload.data?.shop?.myshopifyDomain;
  const accessScopes = payload.data?.currentAppInstallation?.accessScopes;
  if (typeof name !== 'string' || typeof domain !== 'string' || !Array.isArray(accessScopes)) {
    throw new Error('Shopify returned an incomplete response while verifying the token.');
  }

  const verifiedDomain = normalizeShop(domain);
  if (verifiedDomain !== shop) {
    throw new Error(`The token belongs to ${verifiedDomain}, not the configured store ${shop}.`);
  }

  const grantedScopes = accessScopes
    .map(scope => scope.handle)
    .filter((scope): scope is string => typeof scope === 'string');
  const granted = new Set(grantedScopes);
  const missing = REQUIRED_ACCESS_SCOPES.filter(scope => !grantsReadAccess(granted, scope));
  if (missing.length) {
    throw new Error(`The token is missing required access scopes: ${missing.join(', ')}.`);
  }

  return { shopName: name, shopDomain: verifiedDomain, grantedScopes };
}
