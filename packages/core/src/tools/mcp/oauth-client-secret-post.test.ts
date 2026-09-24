/**
 * Token-endpoint client authentication method selection (preset-io/agor#2725).
 *
 * Providers such as HubSpot advertise only `client_secret_post`. Both the
 * authorization-code exchange and the refresh must then send the client
 * credentials in the form body, while every other provider keeps the RFC 8414
 * default of HTTP Basic. The network is mocked the way `oauth-refresh.test.ts`
 * mocks it: `safeOutboundFetch` delegates to a stubbed `globalThis.fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/safe-outbound-fetch', () => ({
  OutboundPreDispatchAuthorityError: class OutboundPreDispatchAuthorityError extends Error {},
  assertSafeOAuthUrl: (input: string, options: { allowLocalhostHttp?: boolean } = {}) => {
    const url = new URL(input);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(options.allowLocalhostHttp && loopback)) {
      throw new Error('OAuth endpoints require HTTPS');
    }
    return url;
  },
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

const { mockGetToken, mockFindById } = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
  mockFindById: vi.fn(),
}));

vi.mock('../../db/repositories', () => ({
  UserMCPOAuthTokenRepository: function UserMCPOAuthTokenRepositoryMock() {
    return {
      getToken: mockGetToken,
      completeStandaloneRefresh: vi.fn(async () => true),
      setStandaloneRefreshState: vi.fn(async () => true),
      deleteGrantVersion: vi.fn(async () => true),
    };
  },
  MCPServerRepository: function MCPServerRepositoryMock() {
    return { findById: mockFindById };
  },
  UsersRepository: function UsersRepositoryMock() {
    return { findById: vi.fn(async () => ({ user_id: 'user-1', role: 'member' })) };
  },
}));

import type { MCPServerID, UserID } from '../../types';
import {
  clearAuthCodeTokenCache,
  completeMCPOAuthFlow,
  selectClientSecretAuthMethod,
  startMCPOAuthFlow,
} from './oauth-mcp-transport';
import {
  __resetClientAuthMethodCacheForTests,
  __resetRefreshMutexForTests,
  refreshAndPersistToken,
  refreshMCPToken,
} from './oauth-refresh';

const ISSUER = 'https://auth.example.test';
const METADATA_URL = `${ISSUER}/.well-known/oauth-authorization-server`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const REGISTRATION_ENDPOINT = `${ISSUER}/oauth/register`;
const REDIRECT_URI = 'http://127.0.0.1:9999/oauth/callback';
const CLIENT_ID = 'hubspot-client';
const CLIENT_SECRET = 'hubspot-secret';
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

const originalFetch = globalThis.fetch;

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
 * Serve RFC 8414 metadata, an optional DCR response and the token endpoint.
 * `metadataStatus` lets a test make discovery fail.
 */
function stubProvider(options: {
  methods?: string[];
  metadataStatus?: number;
  registration?: Record<string, unknown>;
}) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === METADATA_URL) {
      return options.metadataStatus
        ? new Response('unavailable', { status: options.metadataStatus })
        : jsonResponse(authServerMetadata(options.methods));
    }
    if (url === REGISTRATION_ENDPOINT && init?.method === 'POST' && options.registration) {
      return jsonResponse(options.registration, 201);
    }
    if (url === TOKEN_ENDPOINT && init?.method === 'POST') {
      return jsonResponse({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 });
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
  expect(request.body.has('client_secret')).toBe(false);
  expect(request.body.has('client_id')).toBe(false);
}

/** Configured-client exchange against prefetched (AS-direct) metadata. */
async function exchangeWithMetadata(methods?: string[]) {
  const fetchMock = stubProvider({ methods });
  const context = await startMCPOAuthFlow('', CLIENT_ID, REDIRECT_URI, {
    clientSecret: CLIENT_SECRET,
    prefetchedAuthServerMetadata: authServerMetadata(methods),
    cacheKey: 'https://mcp.example.test/mcp',
    resourceUri: 'https://mcp.example.test/mcp',
    compatibilityMode: 'legacy',
    allowLocalhostHttp: true,
  });
  await completeMCPOAuthFlow(context, 'auth-code', context.state, { cacheToken: false });
  return { context, requests: tokenRequests(fetchMock) };
}

/** Standalone refresh of a stored grant issued by `ISSUER`. */
async function refreshStoredGrant(row: Record<string, unknown> = {}) {
  mockGetToken.mockResolvedValue({
    user_id: 'user-1',
    mcp_server_id: 'srv-1',
    oauth_access_token: 'old-access',
    oauth_refresh_token: 'refresh-1',
    oauth_client_id: CLIENT_ID,
    oauth_client_secret: CLIENT_SECRET,
    oauth_issuer: ISSUER,
    oauth_token_endpoint: TOKEN_ENDPOINT,
    grant_generation: 0,
    refresh_status: 'idle',
    refresh_generation: 0,
    refresh_success_generation: 0,
    ...row,
  });
  mockFindById.mockResolvedValue({ url: 'https://mcp.example.test/mcp', auth: {} });
  return refreshAndPersistToken({
    db: { run: () => undefined } as any,
    userId: 'user-1' as UserID,
    mcpServerId: 'srv-1' as MCPServerID,
    observedRefreshVersion: { grantGeneration: 0, refreshGeneration: 0 },
    validateGrant: async () => true,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  clearAuthCodeTokenCache();
  __resetRefreshMutexForTests();
  __resetClientAuthMethodCacheForTests();
  mockGetToken.mockReset();
  mockFindById.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('selectClientSecretAuthMethod', () => {
  it.each([
    [undefined, undefined, 'client_secret_basic'],
    [[], undefined, 'client_secret_basic'],
    [['client_secret_basic'], undefined, 'client_secret_basic'],
    [['client_secret_basic', 'client_secret_post'], undefined, 'client_secret_basic'],
    [['client_secret_post'], undefined, 'client_secret_post'],
    [['client_secret_post', 'private_key_jwt'], undefined, 'client_secret_post'],
    [undefined, 'client_secret_post', 'client_secret_post'],
    [['client_secret_post'], 'client_secret_basic', 'client_secret_post'],
    ['client_secret_post', undefined, 'client_secret_basic'],
  ])('metadata %j with registered %s selects %s', (supported, registered, expected) => {
    expect(selectClientSecretAuthMethod(supported, registered)).toBe(expected);
  });
});

describe('client_secret_post exchange', () => {
  it('client_secret_post exchange sends client_id and client_secret in the form body and no Authorization header', async () => {
    const { context, requests } = await exchangeWithMetadata(['client_secret_post']);

    expect(context.tokenEndpointAuthMethod).toBe('client_secret_post');
    expect(requests).toHaveLength(1);
    expectClientSecretPost(requests[0]);
    expect(requests[0].body.get('grant_type')).toBe('authorization_code');
    expect(requests[0].body.get('code')).toBe('auth-code');
  });
});

describe('client_secret_post refresh', () => {
  it('client_secret_post refresh sends client_id and client_secret in the form body and no Authorization header', async () => {
    const fetchMock = stubProvider({ methods: ['client_secret_post'] });

    await expect(refreshStoredGrant()).resolves.toBe('new-access');

    const requests = tokenRequests(fetchMock);
    expect(requests).toHaveLength(1);
    expectClientSecretPost(requests[0]);
    expect(requests[0].body.get('grant_type')).toBe('refresh_token');
    expect(requests[0].body.get('refresh_token')).toBe('refresh-1');
  });

  it('client_secret_post refresh keeps the last resolved method when metadata is briefly unavailable', async () => {
    stubProvider({ methods: ['client_secret_post'] });
    await refreshStoredGrant();

    // Past the TTL the method is re-resolved; a failed fetch must not
    // silently downgrade a known post-only issuer to Basic.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60 * 60_000);
    const fetchMock = stubProvider({ methods: ['client_secret_post'], metadataStatus: 503 });
    await refreshStoredGrant();

    expect(fetchMock.mock.calls.some(([url]) => String(url) === METADATA_URL)).toBe(true);
    expectClientSecretPost(tokenRequests(fetchMock)[0]);
  });

  it('client_secret_post refreshMCPToken never sends the secret both ways', async () => {
    const fetchMock = stubProvider({});
    await refreshMCPToken({
      tokenEndpoint: TOKEN_ENDPOINT,
      refreshToken: 'refresh-1',
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clientSecretAuthMethod: 'client_secret_post',
    });
    expectClientSecretPost(tokenRequests(fetchMock)[0]);
  });
});

describe('client_secret_basic default', () => {
  it.each([
    ['no advertised methods', undefined],
    ['client_secret_basic advertised', ['client_secret_basic']],
    ['both methods advertised', ['client_secret_basic', 'client_secret_post']],
  ])('client_secret_basic default exchange uses HTTP Basic with %s', async (_label, methods) => {
    const { context, requests } = await exchangeWithMetadata(methods);

    expect(context.tokenEndpointAuthMethod).toBe('client_secret_basic');
    expect(requests).toHaveLength(1);
    expectClientSecretBasic(requests[0]);
  });

  it.each([
    ['no advertised methods', undefined],
    ['client_secret_basic advertised', ['client_secret_basic']],
    ['both methods advertised', ['client_secret_basic', 'client_secret_post']],
  ])('client_secret_basic default refresh uses HTTP Basic with %s', async (_label, methods) => {
    const fetchMock = stubProvider({ methods });

    await expect(refreshStoredGrant()).resolves.toBe('new-access');

    const requests = tokenRequests(fetchMock);
    expect(requests).toHaveLength(1);
    expectClientSecretBasic(requests[0]);
  });

  it('client_secret_basic default refresh uses HTTP Basic when metadata is unavailable', async () => {
    const fetchMock = stubProvider({ methods: ['client_secret_post'], metadataStatus: 404 });

    await refreshStoredGrant();

    expectClientSecretBasic(tokenRequests(fetchMock)[0]);
  });

  it('client_secret_basic default refresh uses HTTP Basic without fetching metadata for a grant with no stored issuer', async () => {
    const fetchMock = stubProvider({ methods: ['client_secret_post'] });

    await refreshStoredGrant({ oauth_issuer: undefined });

    expect(fetchMock.mock.calls.some(([url]) => String(url) === METADATA_URL)).toBe(false);
    expectClientSecretBasic(tokenRequests(fetchMock)[0]);
  });

  it('public clients are unchanged: client_id in the body, no secret, no metadata lookup', async () => {
    const fetchMock = stubProvider({ methods: ['client_secret_post'] });

    await refreshStoredGrant({ oauth_client_secret: undefined });

    expect(fetchMock.mock.calls.some(([url]) => String(url) === METADATA_URL)).toBe(false);
    const [request] = tokenRequests(fetchMock);
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.body.get('client_id')).toBe(CLIENT_ID);
    expect(request.body.has('client_secret')).toBe(false);
  });
});

describe('DCR client_secret_post', () => {
  it('DCR client_secret_post registration with a client_secret is accepted and the exchange uses client_secret_post', async () => {
    const fetchMock = stubProvider({
      // Metadata alone would select Basic: the registration decides.
      registration: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });

    const context = await startMCPOAuthFlow('', undefined, REDIRECT_URI, {
      prefetchedAuthServerMetadata: authServerMetadata(),
      cacheKey: 'https://mcp.example.test/mcp',
      resourceUri: 'https://mcp.example.test/mcp',
      compatibilityMode: 'legacy',
      dcrMode: 'fallback',
      reuseDynamicClientRegistration: false,
      allowLocalhostHttp: true,
    });
    expect(context.clientId).toBe(CLIENT_ID);
    expect(context.clientSecret).toBe(CLIENT_SECRET);
    expect(context.tokenEndpointAuthMethod).toBe('client_secret_post');

    await completeMCPOAuthFlow(context, 'auth-code', context.state, { cacheToken: false });

    const requests = tokenRequests(fetchMock);
    expect(requests).toHaveLength(1);
    expectClientSecretPost(requests[0]);
  });

  it('DCR client_secret_post registration without a client_secret is still refused', async () => {
    stubProvider({
      registration: {
        client_id: CLIENT_ID,
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });

    await expect(
      startMCPOAuthFlow('', undefined, REDIRECT_URI, {
        prefetchedAuthServerMetadata: authServerMetadata(),
        cacheKey: 'https://mcp.example.test/mcp',
        resourceUri: 'https://mcp.example.test/mcp',
        compatibilityMode: 'legacy',
        dcrMode: 'fallback',
        reuseDynamicClientRegistration: false,
        allowLocalhostHttp: true,
      })
    ).rejects.toThrow('omitted the required client secret');
  });
});
