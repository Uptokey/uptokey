import * as oauth from "oauth4webapi";

/** PKCE/state/nonce via oauth4webapi (MIT, panva) — RFC 7636 / OAuth BCP aligned. */
export async function generateCodeVerifier(): Promise<string> {
  return oauth.generateRandomCodeVerifier();
}

export async function codeChallengeS256(verifier: string): Promise<string> {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) throw new Error("pkce_verifier_invalid");
  return oauth.calculatePKCECodeChallenge(verifier);
}

export function generateOAuthState(): string {
  return oauth.generateRandomState();
}

export function generateOidcNonce(): string {
  return oauth.generateRandomNonce();
}

export function asAuthorizationServer(input: {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}): oauth.AuthorizationServer {
  return {
    issuer: input.issuer,
    authorization_endpoint: input.authorizationEndpoint,
    token_endpoint: input.tokenEndpoint,
    ...(input.revocationEndpoint ? { revocation_endpoint: input.revocationEndpoint } : {}),
    code_challenge_methods_supported: ["S256"],
  };
}

export function asClient(clientId: string): oauth.Client {
  return { client_id: clientId };
}

/** Validate callback URL with oauth4webapi before any secret write. */
export function validateOAuthCallback(input: {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  callbackUrl: URL;
  expectedState: string;
}): URLSearchParams {
  const as = asAuthorizationServer({
    issuer: input.issuer,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
  });
  const client = asClient(input.clientId);
  return oauth.validateAuthResponse(as, client, input.callbackUrl, input.expectedState);
}
