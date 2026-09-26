/**
 * The dynamic-client-registration store (block: auth).
 *
 * DCR exists only for claude.ai compatibility: the security boundary is the callback allowlist
 * plus mandatory PKCE, not client authentication (A-12, A-13). Every registered client is a
 * public client (`token_endpoint_auth_method: "none"`) and no secret is ever minted.
 *
 * The store is a bounded LRU (`MAX_DCR_CLIENTS`, ADR-16) in front of the `AUTH_DB_PATH` SQLite
 * table (`client-db.ts`): a registration is written through, a miss in the LRU is served from the
 * table and re-hydrated, and only a `client_id` neither remembers is reconstructed with exactly
 * the claude.ai callback plus the loopback URIs (A-12). The reconstruction is never written back,
 * to either layer - see `resolve` for why.
 */
import { randomBytes, createHash } from 'node:crypto';

import {
  RECONSTRUCTED_CLIENT_REDIRECT_URIS,
  isAllowedRedirectUri,
  type OAuthClient,
} from '../contracts/index.js';

import type { ClientPersistence } from './client-db.js';
import { BoundedLru } from './store.js';

/** The client metadata as `/register` echoes it back (RFC 7591). */
export interface RegisteredClient extends OAuthClient {
  readonly client_id_issued_at: number;
  readonly application_type: string | null;
  readonly grant_types: readonly string[];
  readonly response_types: readonly string[];
  readonly scope: string | null;
}

export type RegistrationFailure =
  | { readonly error: 'invalid_redirect_uri'; readonly error_description: string }
  | { readonly error: 'invalid_client_metadata'; readonly error_description: string };

/**
 * Caps on what one `/register` call may make this process retain (ADR-16).
 *
 * claude.ai sends exactly one callback; Claude Code and the Inspector send one loopback each. Ten
 * is generous. Without these two bounds a single unauthenticated call retained megabytes, and a
 * full `MAX_DCR_CLIENTS` LRU of such registrations was gigabytes on a 1 GiB single instance.
 */
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 512;
/** The other free-text fields are echoed and stored, so they are clamped rather than refused. */
export const MAX_CLIENT_TEXT_LENGTH = 256;
export const MAX_CLIENT_LIST_ENTRIES = 10;

/**
 * How many `MAX_DCR_CLIENTS` of history the SQLite table keeps behind the LRU.
 *
 * Not 1: a table the same size as the LRU only survives a restart, and the second thing the table
 * is for is eviction - a client the LRU dropped under a registration flood is re-hydrated instead
 * of being rebuilt with the bare loopback URIs, which is what breaks Claude Code and the
 * Inspector. Not unbounded either (ADR-16): four times the default 1000 clients is a few megabytes
 * of a memory-backed `/tmp` on Cloud Run.
 */
export const PERSISTED_CLIENT_CAPACITY_MULTIPLIER = 4;

/** Keeps a caller-supplied string bounded without failing a registration over a long name. */
function clamp(value: string): string {
  return value.length <= MAX_CLIENT_TEXT_LENGTH ? value : value.slice(0, MAX_CLIENT_TEXT_LENGTH);
}

export type RegistrationResult =
  | { readonly ok: true; readonly client: RegisteredClient }
  | { readonly ok: false; readonly failure: RegistrationFailure };

export interface ClientStoreOptions {
  readonly capacity: number;
  /** MCP Inspector's `/oauth/callback` loopback is accepted outside production only (A-13). */
  readonly allowDevLoopback: boolean;
  readonly now?: () => Date;
  readonly newClientId?: () => string;
  /**
   * The SQLite table behind the LRU (A-12). Omitted, the store is memory only and a restart makes
   * every registered client unknown - the T0.3 behaviour.
   */
  readonly persistence?: ClientPersistence | null;
}

/** A short, stable hash of a `client_id`; the raw value never reaches an event or a log line. */
export function clientIdFingerprint(clientId: string): string {
  return createHash('sha256').update(clientId).digest('hex').slice(0, 12);
}

export interface ClientStore {
  register(metadata: unknown): RegistrationResult;
  get(clientId: string): RegisteredClient | undefined;
  /** The client for an id, reconstructing an unknown one (A-12). Never returns undefined. */
  resolve(clientId: string): { readonly client: RegisteredClient; readonly reconstructed: boolean };
  /** Entries in the in-memory LRU. */
  readonly size: number;
  /** Rows in the SQLite table; `0` when there is none (diagnostics and the restart test). */
  readonly persistedSize: number;
  /** True when nothing is being persisted, so a restart will reconstruct instead of restore. */
  readonly persistenceDegraded: boolean;
  /** Releases the SQLite handle. Safe to call twice. */
  close(): void;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

export function createClientStore(options: ClientStoreOptions): ClientStore {
  const now = options.now ?? (() => new Date());
  const newClientId = options.newClientId ?? (() => `mcpb_${randomBytes(16).toString('hex')}`);
  const clients = new BoundedLru<string, RegisteredClient>(options.capacity);
  const persistence = options.persistence ?? null;

  // Warm the LRU from the table, oldest first, so the most recently seen client is also the most
  // recently used one and survives the first eviction after a restart.
  if (persistence !== null) {
    for (const client of persistence.load(options.capacity)) clients.set(client.client_id, client);
  }

  /** LRU miss -> SQLite. A hit is re-hydrated and marked recently seen. */
  function hydrate(clientId: string): RegisteredClient | undefined {
    if (persistence === null) return undefined;
    const stored = persistence.get(clientId);
    if (stored === null) return undefined;
    clients.set(clientId, stored);
    persistence.touch(clientId, now().getTime());
    return stored;
  }

  function reconstruct(clientId: string): RegisteredClient {
    return {
      client_id: clientId,
      client_name: null,
      redirect_uris: RECONSTRUCTED_CLIENT_REDIRECT_URIS,
      token_endpoint_auth_method: 'none',
      reconstructed: true,
      client_id_issued_at: Math.floor(now().getTime() / 1000),
      application_type: null,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: null,
    };
  }

  return {
    get size() {
      return clients.size;
    },

    get persistedSize() {
      return persistence === null ? 0 : persistence.count();
    },

    get persistenceDegraded() {
      return persistence === null || persistence.degraded;
    },

    close() {
      persistence?.close();
    },

    register(metadata: unknown): RegistrationResult {
      if (metadata === null || typeof metadata !== 'object') {
        return {
          ok: false,
          failure: {
            error: 'invalid_client_metadata',
            error_description: 'The registration request body must be a JSON object.',
          },
        };
      }
      const body = metadata as Record<string, unknown>;

      const redirectUris = asStringArray(body.redirect_uris);
      if (redirectUris === null || redirectUris.length === 0) {
        return {
          ok: false,
          failure: {
            error: 'invalid_redirect_uri',
            error_description: 'redirect_uris must be a non-empty array of strings.',
          },
        };
      }
      if (redirectUris.length > MAX_REDIRECT_URIS) {
        return {
          ok: false,
          failure: {
            error: 'invalid_redirect_uri',
            error_description: `redirect_uris may list at most ${MAX_REDIRECT_URIS} callback URLs.`,
          },
        };
      }
      for (const uri of redirectUris) {
        if (uri.length > MAX_REDIRECT_URI_LENGTH) {
          return {
            ok: false,
            failure: {
              error: 'invalid_redirect_uri',
              error_description: `A redirect URI may be at most ${MAX_REDIRECT_URI_LENGTH} characters long.`,
            },
          };
        }
        if (!isAllowedRedirectUri(uri, { allowDevLoopback: options.allowDevLoopback })) {
          return {
            ok: false,
            failure: {
              error: 'invalid_redirect_uri',
              error_description: `The redirect URI ${uri} is not on this server's callback allowlist.`,
            },
          };
        }
      }

      const authMethod = body.token_endpoint_auth_method;
      if (authMethod !== undefined && authMethod !== 'none') {
        // Public clients only: a confidential client would need a secret this server never mints.
        return {
          ok: false,
          failure: {
            error: 'invalid_client_metadata',
            error_description:
              'This server registers public clients only: token_endpoint_auth_method must be "none".',
          },
        };
      }

      const clientName = typeof body.client_name === 'string' ? clamp(body.client_name) : null;
      const applicationType =
        typeof body.application_type === 'string' ? clamp(body.application_type) : null;
      const grantTypes = (
        asStringArray(body.grant_types) ?? ['authorization_code', 'refresh_token']
      )
        .slice(0, MAX_CLIENT_LIST_ENTRIES)
        .map(clamp);
      const responseTypes = (asStringArray(body.response_types) ?? ['code'])
        .slice(0, MAX_CLIENT_LIST_ENTRIES)
        .map(clamp);
      const scope = typeof body.scope === 'string' ? clamp(body.scope) : null;

      const client: RegisteredClient = {
        client_id: newClientId(),
        client_name: clientName,
        // De-duplicated: a client that lists the same callback twice gets it stored once.
        redirect_uris: [...new Set(redirectUris)],
        token_endpoint_auth_method: 'none',
        reconstructed: false,
        client_id_issued_at: Math.floor(now().getTime() / 1000),
        application_type: applicationType,
        grant_types: grantTypes,
        response_types: responseTypes,
        scope,
      };
      clients.set(client.client_id, client);
      if (persistence !== null) {
        const seenAt = now().getTime();
        persistence.save(client, seenAt);
        persistence.prune(options.capacity * PERSISTED_CLIENT_CAPACITY_MULTIPLIER);
      }
      return { ok: true, client };
    },

    get(clientId: string) {
      return clients.get(clientId) ?? hydrate(clientId);
    },

    resolve(clientId: string) {
      const known = clients.get(clientId) ?? hydrate(clientId);
      if (known) return { client: known, reconstructed: false };
      // The reconstruction is NOT written back, to the LRU or to the table. `/authorize` calls
      // this for any `client_id` a stranger types, so persisting it let an unauthenticated flood
      // evict real `/register` entries; an evicted client is then rebuilt with only
      // RECONSTRUCTED_CLIENT_REDIRECT_URIS, which breaks every client that registered a loopback
      // callback with a port (the MCP Inspector, Claude Code, VS Code). Rebuilding is
      // deterministic and free.
      return { client: reconstruct(clientId), reconstructed: true };
    },
  };
}
