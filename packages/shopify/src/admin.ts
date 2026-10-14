import { normalizeShop } from '../../shared/src/shop.js';
import { ShopifyAdminClient } from './admin-client.js';

export { SHOPIFY_API_VERSION } from './admin-client.js';
export const REQUIRED_ACCESS_SCOPES = ['read_products'] as const;

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

type VerificationPayload = {
  shop?: { name?: unknown; myshopifyDomain?: unknown };
  currentAppInstallation?: { accessScopes?: Array<{ handle?: unknown }> };
};

type Fetch = typeof globalThis.fetch;

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

  const client = new ShopifyAdminClient(shop, token, fetcher);
  const { data: payload } = await client.query<VerificationPayload>(verificationQuery);
  const name = payload.shop?.name;
  const domain = payload.shop?.myshopifyDomain;
  const accessScopes = payload.currentAppInstallation?.accessScopes;
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
