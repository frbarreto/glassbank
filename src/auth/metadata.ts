/**
 * Discovery documents (block: auth).
 *
 * RFC 9728 protected-resource metadata at BOTH `/.well-known/oauth-protected-resource` and
 * `/.well-known/oauth-protected-resource/mcp`, and RFC 8414 authorization-server metadata at
 * `/.well-known/oauth-authorization-server`.
 *
 * Every URL in every document is derived from the **validated request `Host`** when that host is
 * listed in `PUBLIC_HOSTS`, with `PUBLIC_BASE_URL` as the fallback (A-36, CLAUDE.md invariant 4).
 * A user who types the other `run.app` form must not be told the resource is a different origin,
 * because the client would then request a token for an audience the verifier rejects.
 */
import {
  OAUTH_METADATA_CONSTANTS,
  OAUTH_ROUTES,
  canonicalMcpUrl,
  issuerUrl,
  supportedScopes,
} from '../contracts/index.js';

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly string[];
  readonly resource_name: string;
  readonly resource_documentation: string;
}

export function protectedResourceMetadata(
  baseUrl: string,
  enabledFlags: readonly string[],
): ProtectedResourceMetadata {
  return {
    resource: canonicalMcpUrl(baseUrl),
    authorization_servers: [issuerUrl(baseUrl)],
    scopes_supported: supportedScopes(enabledFlags),
    bearer_methods_supported: ['header'],
    resource_name: 'Glass Bank MCP',
    resource_documentation: `${issuerUrl(baseUrl)}/xray`,
  };
}

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly registration_endpoint: string;
  readonly revocation_endpoint: string;
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly revocation_endpoint_auth_methods_supported: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly authorization_response_iss_parameter_supported: boolean;
  readonly service_documentation: string;
}

export function authorizationServerMetadata(
  baseUrl: string,
  enabledFlags: readonly string[],
): AuthorizationServerMetadata {
  const issuer = issuerUrl(baseUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}${OAUTH_ROUTES.authorize}`,
    token_endpoint: `${issuer}${OAUTH_ROUTES.token}`,
    registration_endpoint: `${issuer}${OAUTH_ROUTES.register}`,
    revocation_endpoint: `${issuer}${OAUTH_ROUTES.revoke}`,
    response_types_supported: OAUTH_METADATA_CONSTANTS.responseTypesSupported,
    grant_types_supported: OAUTH_METADATA_CONSTANTS.grantTypesSupported,
    code_challenge_methods_supported: OAUTH_METADATA_CONSTANTS.codeChallengeMethodsSupported,
    token_endpoint_auth_methods_supported:
      OAUTH_METADATA_CONSTANTS.tokenEndpointAuthMethodsSupported,
    revocation_endpoint_auth_methods_supported:
      OAUTH_METADATA_CONSTANTS.tokenEndpointAuthMethodsSupported,
    scopes_supported: supportedScopes(enabledFlags),
    authorization_response_iss_parameter_supported:
      OAUTH_METADATA_CONSTANTS.authorizationResponseIssParameterSupported,
    service_documentation: `${issuer}/xray`,
    // CIMD (`client_id_metadata_document_supported`) is deliberately absent until CIMD_ENABLED
    // is implemented and DCR has been observed working (A-37, CLAUDE.md "Don't").
  };
}
