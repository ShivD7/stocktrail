import { AsyncEntry, type EntryOptions } from '@napi-rs/keyring';
import { normalizeShop } from './config.js';

export const CREDENTIAL_SERVICE = 'StockTrail Shopify Admin';

export interface CredentialStore {
  getToken(shop: string): Promise<string | null>;
  setToken(shop: string, token: string): Promise<void>;
  deleteToken(shop: string): Promise<boolean>;
}

function keyringOptions(): EntryOptions | undefined {
  // A desktop Secret Service persists credentials. Do not silently fall back to
  // Linux's in-memory kernel keyring, where a login would disappear on reboot.
  return process.platform === 'linux'
    ? { linux: { store: 'secret-service' } }
    : undefined;
}

function entryFor(shop: string): AsyncEntry {
  return new AsyncEntry(CREDENTIAL_SERVICE, normalizeShop(shop), keyringOptions());
}

function credentialError(action: string): Error {
  return new Error(
    `Could not ${action} the Shopify token in the operating system credential store. ` +
    'Make sure the credential store is available and unlocked.',
  );
}

export class SystemCredentialStore implements CredentialStore {
  async getToken(shop: string): Promise<string | null> {
    try {
      return await entryFor(shop).getPassword();
    } catch {
      throw credentialError('read');
    }
  }

  async setToken(shop: string, token: string): Promise<void> {
    try {
      await entryFor(shop).setPassword(token);
    } catch {
      throw credentialError('save');
    }
  }

  async deleteToken(shop: string): Promise<boolean> {
    try {
      return await entryFor(shop).deletePassword();
    } catch {
      throw credentialError('delete');
    }
  }
}
