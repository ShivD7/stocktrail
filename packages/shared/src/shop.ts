export function normalizeShop(input: string): string {
  const shop = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    throw new Error('Use a store hostname such as your-store.myshopify.com (no URL or path).');
  }
  return shop;
}
