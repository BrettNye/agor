/**
 * The token-endpoint auth method is stored on the grant (preset-io/agor#2725).
 *
 * The code exchange chooses how to present the client secret, and the grant
 * row records that choice in `oauth_token_endpoint_auth_method`. Refresh reads
 * it back instead of re-deriving it from authorization server metadata, so the
 * two requests cannot diverge and refresh never fetches metadata. A NULL
 * method is a grant stored before the column existed: it refreshes with HTTP
 * Basic whenever it has a secret, exactly as before.
 *
 * Only the network is replaced. The database is a real migrated SQLite handle
 * behind the production scope guard, and the repositories are real, so these
 * tests also cover the column the migration adds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/safe-outbound-fetch', () => ({
  OutboundPreDispatchAuthorityError: class OutboundPreDispatchAuthorityError extends Error {},
  assertSafeOAuthUrl: (input: string) => new URL(input),
  safeOutboundFetch: async (input: string | URL, options: Record<string, unknown> = {}) => {
    const {
      timeoutMs: _timeout,
      maxRedirects: _max,
      maxResponseBytes: _bytes,
      allowLocalhostHttp: _local,
      assertCurrent: _assertCurrent,
      resolveDns: _resolveDns,
      ...init
    } = options;
    return globalThis.fetch(input, init as RequestInit);
  },
}));

import { eq } from 'drizzle-orm';
import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  MCPServerRepository,
  runMigrations,
  runWithTenantContext,
  type SaveTokenInput,
  type TenantScopeAwareDatabase,
  UserMCPOAuthTokenRepository,
  UsersRepository,
} from '../../db';
import { select } from '../../db/database-wrapper';
import { userMcpOauthTokens } from '../../db/schema';
import type { MCPServerID, UserID } from '../../types';
import {
  clearAuthCodeTokenCache,
  completeMCPOAuthFlow,
  type OAuthFlowContext,
  startMCPOAuthFlow,
} from './oauth-mcp-transport';
import { __resetRefreshMutexForTests, refreshAndPersistToken } from './oauth-refresh';

const TENANT = 'default';
const ISSUER = 'https://auth.example.test';
const METADATA_URL = `${ISSUER}/.well-known/oauth-authorization-server`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const REGISTRATION_ENDPOINT = `${ISSUER}/oauth/register`;
const REDIRECT_URI = 'http://127.0.0.1:9999/oauth/callback';
const RESOURCE = 'https://mcp.example.test/mcp';
const CLIENT_ID = 'dcr-client';
const CLIENT_SECRET = 'dcr-secret';
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

const originalFetch = globalThis.fetch;

let raw: Awaited<ReturnType<typeof createDatabaseAsync>>;
let guarded: TenantScopeAwareDatabase;
let userId: UserID;
let serverId: MCPServerID;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function authServerMetadata(methods?: string[]) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: TOKEN_ENDPOINT,
    registration_endpoint: REGISTRATION_ENDPOINT,
    ...(methods ? { token_endpoint_auth_methods_supported: methods } : {}),
  };
}

/**
 * Serve RFC 8414 metadata advertising `methods`, an optional DCR response and
 * the token endpoint. Metadata stays reachable so a test can prove refresh
 * never asks for it, rather than merely surviving its absence.
 */
function stubProvider(options: { methods?: string[]; registration?: Record<string, unknown> }) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === METADATA_URL) return jsonResponse(authServerMetadata(options.methods));
    if (url === REGISTRATION_ENDPOINT && init?.method === 'POST' && options.registration) {
      return jsonResponse(options.registration, 201);
    }
    if (url === TOKEN_ENDPOINT && init?.method === 'POST') {
      return jsonResponse({
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    return new Response('not found', { status: 404 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function tokenRequests(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([url]) => String(url) === TOKEN_ENDPOINT)
    .map(([, init]) => {
      const request = init as RequestInit;
      return {
        headers: request.headers as Record<string, string>,
        body: new URLSearchParams(request.body as string),
      };
    });
}

function metadataFetches(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url) === METADATA_URL).length;
}

/** Persist the grant the way the daemon does after a completed flow. */
function persistGrant(input: Partial<SaveTokenInput> = {}) {
  return runWithTenantContext(TENANT, () =>
    new UserMCPOAuthTokenRepository(raw).saveToken(userId, serverId, {
      accessToken: 'lapsed-access',
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      refreshToken: 'good-refresh',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      tokenEndpoint: TOKEN_ENDPOINT,
      resourceUri: RESOURCE,
      ...input,
    })
  );
}

/** `persistOAuthToken` maps a completed flow context onto the grant like this. */
function persistFromContext(context: OAuthFlowContext) {
  return persistGrant({
    clientId: context.clientId,
    clientSecret: context.clientSecret,
    tokenEndpointAuthMethod: context.tokenEndpointAuthMethod,
    tokenEndpoint: context.tokenEndpoint,
  });
}

function storedGrant() {
  return runWithTenantContext(TENANT, () =>
    new UserMCPOAuthTokenRepository(raw).getToken(userId, serverId)
  );
}

async function storedMethodColumn(): Promise<unknown> {
  const row = await select(raw, {
    method: userMcpOauthTokens.oauth_token_endpoint_auth_method,
  })
    .from(userMcpOauthTokens)
    .where(eq(userMcpOauthTokens.mcp_server_id, serverId))
    .one();
  return row?.method;
}

function refreshGrant(observed = { grantGeneration: 0, refreshGeneration: 0 }) {
  return runWithTenantContext(TENANT, () =>
    refreshAndPersistToken({
      db: guarded,
      tenantId: TENANT,
      userId,
      mcpServerId: serverId,
      observedRefreshVersion: { ...observed, grantBindingFingerprint: undefined },
      validateGrant: async () => true,
      allowLocalhostHttpDevelopment: false,
    })
  );
}

function expectClientSecretPost(request: {
  headers: Record<string, string>;
  body: URLSearchParams;
}) {
  expect(request.headers.Authorization).toBeUndefined();
  expect(request.body.get('client_id')).toBe(CLIENT_ID);
  expect(request.body.get('client_secret')).toBe(CLIENT_SECRET);
}

function expectClientSecretBasic(request: {
  headers: Record<string, string>;
  body: URLSearchParams;
}) {
  expect(request.headers.Authorization).toBe(BASIC);
  expect(request.body.has('client_id')).toBe(false);
  expect(request.body.has('client_secret')).toBe(false);
}

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  __resetRefreshMutexForTests();
  clearAuthCodeTokenCache();
  raw = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
  await runMigrations(raw);
  guarded = createTenantScopedDatabaseProxy(raw, {
    requireScope: true,
    label: 'auth method persistence test',
  });
  const user = await new UsersRepository(raw).create({
    email: `auth-method-${Math.random()}@example.test`,
    role: 'admin',
  });
  userId = user.user_id as UserID;
  const server = await new MCPServerRepository(raw).create({
    name: 'auth-method-persistence',
    transport: 'http',
    url: RESOURCE,
    scope: 'global',
    enabled: true,
    source: 'user',
    owner_user_id: userId,
    auth: { type: 'oauth', oauth_mode: 'per_user' },
  });
  serverId = server.mcp_server_id as MCPServerID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  (raw as unknown as { $client?: { close(): void } }).$client?.close();
});

describe('DCR client_secret_post against metadata that advertises no methods', () => {
  it('exchanges and then refreshes with client_id and client_secret in the form body and no Authorization header', async () => {
    const exchangeFetch = stubProvider({
      registration: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    const context = await startMCPOAuthFlow('', undefined, REDIRECT_URI, {
      prefetchedAuthServerMetadata: authServerMetadata(),
      cacheKey: RESOURCE,
      resourceUri: RESOURCE,
      compatibilityMode: 'legacy',
      dcrMode: 'fallback',
      reuseDynamicClientRegistration: false,
      allowLocalhostHttp: true,
    });
    await completeMCPOAuthFlow(context, 'auth-code', context.state, { cacheToken: false });
    expectClientSecretPost(tokenRequests(exchangeFetch)[0]);
    await persistFromContext(context);

    // The metadata alone would select Basic; the stored method must win.
    const refreshFetch = stubProvider({});
    await expect(refreshGrant()).resolves.toBe('fresh-access');

    const requests = tokenRequests(refreshFetch);
    expect(requests).toHaveLength(1);
    expectClientSecretPost(requests[0]);
    expect(requests[0].body.get('grant_type')).toBe('refresh_token');
    expect(requests[0].body.get('refresh_token')).toBe('good-refresh');
  });
});

describe('persisting a grant stores the method the exchange used', () => {
  it.each([
    ['client_secret_post', ['client_secret_post']],
    ['client_secret_basic', ['client_secret_basic', 'client_secret_post']],
  ] as const)('stores %s, the method name only', async (method, methods) => {
    stubProvider({ methods: [...methods] });
    const context = await startMCPOAuthFlow('', CLIENT_ID, REDIRECT_URI, {
      clientSecret: CLIENT_SECRET,
      prefetchedAuthServerMetadata: authServerMetadata([...methods]),
      cacheKey: RESOURCE,
      resourceUri: RESOURCE,
      compatibilityMode: 'legacy',
      allowLocalhostHttp: true,
    });
    await completeMCPOAuthFlow(context, 'auth-code', context.state, { cacheToken: false });
    await persistFromContext(context);

    await expect(storedMethodColumn()).resolves.toBe(method);
    await expect(storedGrant()).resolves.toMatchObject({
      oauth_token_endpoint_auth_method: method,
    });
  });

  it('stores the method on a bound grant and replaces it with the next grant', async () => {
    const binding = {
      version: 4 as const,
      fingerprint: 'f'.repeat(64),
      metadataUri: METADATA_URL,
      resourceUri: RESOURCE,
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/oauth/authorize`,
      tokenEndpoint: TOKEN_ENDPOINT,
      redirectUri: REDIRECT_URI,
    };
    await persistGrant({
      tokenEndpointAuthMethod: 'client_secret_post',
      grantBinding: { ...binding, generation: 1 },
    });
    await expect(storedMethodColumn()).resolves.toBe('client_secret_post');

    // A replacement grant carries only its own exchange's method.
    await persistGrant({ grantBinding: { ...binding, generation: 2 } });
    await expect(storedMethodColumn()).resolves.toBeNull();
  });

  it('refreshes with a stored client_secret_post without fetching authorization server metadata', async () => {
    await persistGrant({ tokenEndpointAuthMethod: 'client_secret_post' });
    // Metadata that would select Basic proves the stored method is used as is.
    const fetchMock = stubProvider({ methods: ['client_secret_basic'] });

    await expect(refreshGrant()).resolves.toBe('fresh-access');

    expect(metadataFetches(fetchMock)).toBe(0);
    expect(tokenRequests(fetchMock)).toHaveLength(1);
    expectClientSecretPost(tokenRequests(fetchMock)[0]);
  });

  it('refreshes with a stored client_secret_basic without fetching authorization server metadata', async () => {
    await persistGrant({ tokenEndpointAuthMethod: 'client_secret_basic' });
    const fetchMock = stubProvider({ methods: ['client_secret_post'] });

    await expect(refreshGrant()).resolves.toBe('fresh-access');

    expect(metadataFetches(fetchMock)).toBe(0);
    expectClientSecretBasic(tokenRequests(fetchMock)[0]);
  });
});

describe('a grant whose stored method is null', () => {
  it('refreshes with HTTP Basic when it has a secret, and fetches no metadata', async () => {
    await persistGrant();
    await expect(storedMethodColumn()).resolves.toBeNull();
    // Even a post-only issuer does not change a pre-migration grant's refresh.
    const fetchMock = stubProvider({ methods: ['client_secret_post'] });

    await expect(refreshGrant()).resolves.toBe('fresh-access');

    expect(metadataFetches(fetchMock)).toBe(0);
    expect(tokenRequests(fetchMock)).toHaveLength(1);
    expectClientSecretBasic(tokenRequests(fetchMock)[0]);
  });

  it('keeps refreshing with HTTP Basic after a rotation, and never fetches metadata', async () => {
    await persistGrant();
    const fetchMock = stubProvider({ methods: ['client_secret_post'] });

    await refreshGrant();
    await refreshGrant({ grantGeneration: 0, refreshGeneration: 1 });

    expect(metadataFetches(fetchMock)).toBe(0);
    const requests = tokenRequests(fetchMock);
    expect(requests).toHaveLength(2);
    for (const request of requests) expectClientSecretBasic(request);
    await expect(storedMethodColumn()).resolves.toBeNull();
  });
});
