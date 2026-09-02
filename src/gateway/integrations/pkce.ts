import { createHash, randomBytes } from 'crypto';

/** PKCE code_verifier (RFC 7636). */
export function newCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE S256 code_challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
