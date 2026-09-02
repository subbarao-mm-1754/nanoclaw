import type { OAuthProviderConfig } from '../types.js';
import { zohoProvider } from './zoho.js';

const providers = new Map<string, OAuthProviderConfig>([[zohoProvider.id, zohoProvider]]);

export function getOAuthProvider(id: string): OAuthProviderConfig | null {
  return providers.get(id) ?? null;
}

export function listOAuthProviders(): OAuthProviderConfig[] {
  return [...providers.values()];
}

export function registerOAuthProvider(provider: OAuthProviderConfig): void {
  providers.set(provider.id, provider);
}
