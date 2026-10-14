import { type CredentialStore, SystemCredentialStore } from './credentials.js';
import { verifyShopifyToken, type ShopifyConnection } from '../../shopify/src/admin.js';

type Fetch = typeof globalThis.fetch;

export async function connect(
  shop: string,
  token: string,
  credentialStore: CredentialStore = new SystemCredentialStore(),
  fetcher: Fetch = globalThis.fetch,
): Promise<ShopifyConnection> {
  const normalizedToken = token.trim();
  const connection = await verifyShopifyToken(shop, normalizedToken, fetcher);
  await credentialStore.setToken(connection.shopDomain, normalizedToken);
  return connection;
}

export async function disconnect(
  shop: string,
  credentialStore: CredentialStore = new SystemCredentialStore(),
): Promise<boolean> {
  return credentialStore.deleteToken(shop);
}

export async function readStoredToken(
  shop: string,
  credentialStore: CredentialStore = new SystemCredentialStore(),
): Promise<string> {
  const token = await credentialStore.getToken(shop);
  if (!token) throw new Error(`No Shopify token is stored for ${shop}. Run stocktrail connect.`);
  return token;
}
