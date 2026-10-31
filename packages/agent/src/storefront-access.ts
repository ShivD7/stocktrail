import { SystemStorefrontCredentialStore, type CredentialStore } from './credentials.js';
import { authenticateStorefront, validateStorefrontPassword } from '../../shopify/src/storefront-session.js';

export async function storefrontAccessStatus(
  shop: string, store: CredentialStore = new SystemStorefrontCredentialStore(),
): Promise<{ status: 'stored' | 'missing' | 'unavailable' }> {
  try { return { status: await store.getToken(shop) ? 'stored' : 'missing' }; }
  catch { return { status: 'unavailable' }; }
}

export async function saveStorefrontPassword(
  shop: string, password: string,
  store: CredentialStore = new SystemStorefrontCredentialStore(),
  authenticate: typeof authenticateStorefront = authenticateStorefront,
): Promise<void> {
  validateStorefrontPassword(password);
  await authenticate(shop, password);
  await store.setToken(shop, password);
}

export async function removeStorefrontPassword(
  shop: string, store: CredentialStore = new SystemStorefrontCredentialStore(),
): Promise<boolean> {
  return store.deleteToken(shop);
}
