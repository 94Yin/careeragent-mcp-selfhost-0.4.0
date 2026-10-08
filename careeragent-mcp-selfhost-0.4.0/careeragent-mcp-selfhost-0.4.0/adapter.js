import { timingSafeEqual, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRemoteJWKSet, createLocalJWKSet, jwtVerify } from 'jose';

const loopback = host => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
export class AdapterError extends Error {
  constructor(envelope) { super(envelope.error.message); this.envelope = envelope; }
}
export function failure(code, message, retryable = false, httpStatus) {
  return new AdapterError({ success: false, ...(httpStatus ? { http_status: httpStatus } : {}), error: { code, message, retryable } });
}
export function loadConfig(env = process.env) {
  const mode = (env.MOCK_MODE ?? 'false').toLowerCase();
  if (!['true', 'false'].includes(mode)) throw new Error('MOCK_MODE must be true or false');
  const mock = mode === 'true';
  const environment = env.MCP_ENVIRONMENT ?? 'PRODUCTION';
  const host = env.HOST ?? '127.0.0.1';
  if (env.MCP_IDENTITY_MODE === 'TEST_NGROK' && mock) throw new Error('TEST_NGROK forbids Mock');
  if (mock) {
    if (!['TEST', 'DEV'].includes(environment) || env.NODE_ENV === 'production' || !loopback(host)) {
      throw new Error('Mock requires explicit TEST/DEV, non-production and loopback HOST');
    }
    return { mock, environment, host, bearer: env.MCP_BEARER_TOKEN ?? '' };
  }
  if (!env.CAREER_RUNTIME_BASE_URL) throw new Error('CAREER_RUNTIME_BASE_URL required in real mode');
  const base = new URL(env.CAREER_RUNTIME_BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid Backend base URL');
  }
  if (env.MCP_IDENTITY_MODE === 'TEST_NGROK') {
    if (environment !== 'TEST' || env.MCP_DATA_CLASS !== 'FIXTURE' || env.NODE_ENV === 'production') throw new Error('TEST_NGROK requires non-production TEST/FIXTURE');
    const origin = env.CAREER_RUNTIME_ALLOWED_ORIGIN;
    let permitted;
    try { permitted = new URL(origin); } catch { throw new Error('Exact HTTPS origin required'); }
    if (permitted.protocol !== 'https:' || origin !== permitted.origin || loopback(permitted.hostname)
        || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:ngrok-free\.app|ngrok\.app|ngrok\.dev)$/.test(permitted.hostname)
        || permitted.port || base.href !== `${origin}/api/v1`) throw new Error('Exact ngrok HTTPS origin and /api/v1 required');
    if (!/^[a-f0-9]{64}$/i.test(env.A02_TUNNEL_KEY || '')) throw new Error('A02_TUNNEL_KEY required');
    if (!env.CAREER_RUNTIME_TOKEN || (env.MCP_BEARER_TOKEN || '').length < 32) throw new Error('Trusted TEST credentials required');
    if (env.CAREER_RUNTIME_JWKS_URL) throw new Error('External JWKS URL forbidden in TEST_NGROK');
    if (!/^frontend_fixture_user_[ab]$/.test(env.MCP_TEST_SUBJECT || '')) throw new Error('Fixture subject required');
    const deadline = Date.parse(env.MCP_TEST_EXPIRES_AT);
    if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now()+86400000) throw new Error('TEST deadline must be within 24 hours');
    const timeoutMs = Number(env.CAREER_RUNTIME_TIMEOUT_MS ?? 10000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Timeout must be 1..60000 ms');
    let jwks;
    try {
      if (!env.A02_TEST_JWKS_FILE || !/^[a-f0-9]{64}$/i.test(env.A02_TEST_JWKS_SHA256 || '') || statSync(env.A02_TEST_JWKS_FILE).size > 65536) throw new Error();
      const bytes = readFileSync(env.A02_TEST_JWKS_FILE);
      if (createHash('sha256').update(bytes).digest('hex') !== env.A02_TEST_JWKS_SHA256.toLowerCase()) throw new Error();
      jwks = JSON.parse(bytes.toString('utf8'));
      if (Object.keys(jwks).join() !== 'keys' || jwks.keys?.length !== 1) throw new Error();
      const key = jwks.keys[0];
      if (Object.keys(key).some(k=>!['kty','n','e','kid','alg','use'].includes(k)) || key.kty !== 'RSA' || key.alg !== 'RS256'
          || key.use !== 'sig' || !/^[A-Za-z0-9_-]{1,128}$/.test(key.kid || '') || !/^[A-Za-z0-9_-]+$/.test(key.n || '')
          || Buffer.from(key.n,'base64url').length < 256 || key.e !== 'AQAB') throw new Error();
    } catch { throw new Error('Pinned public-only TEST JWKS invalid'); }
    return {mock:false,environment,host,identityMode:'TEST_NGROK',base:base.href,allowedOrigin:origin,timeoutMs,
      bearer:env.MCP_BEARER_TOKEN,token:env.CAREER_RUNTIME_TOKEN,tunnelKey:env.A02_TUNNEL_KEY,jwksDocument:jwks,
      subject:env.MCP_TEST_SUBJECT,deadline,issuer:'urn:a02:careeragent:test',audience:'urn:a02:careeragent:backend:test'};
  }
  // This release deliberately does not claim to implement production Ant identity.
  if (env.MCP_IDENTITY_MODE !== 'TEST_LOCAL' || environment !== 'TEST' || env.NODE_ENV === 'production'
      || !loopback(host) || !loopback(base.hostname)) {
    throw new Error('Only explicitly configured TEST_LOCAL loopback identity is supported; production identity is not configured');
  }
  if (!env.CAREER_RUNTIME_TOKEN || !env.MCP_BEARER_TOKEN || env.MCP_BEARER_TOKEN.length < 32) {
    throw new Error('TEST_LOCAL requires Backend JWT and a caller credential of at least 32 characters');
  }
  if (!env.CAREER_RUNTIME_JWKS_URL) throw new Error('Trusted TEST JWKS URL required');
  const jwks = new URL(env.CAREER_RUNTIME_JWKS_URL);
  if (!['http:', 'https:'].includes(jwks.protocol) || !loopback(jwks.hostname) || jwks.username || jwks.password) {
    throw new Error('TEST_LOCAL requires loopback JWKS');
  }
  const timeoutMs = Number(env.CAREER_RUNTIME_TIMEOUT_MS ?? 10000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Timeout must be 1..60000 ms');
  const tunnelKey = env.A02_TUNNEL_KEY;
  if (tunnelKey && !/^[a-f0-9]{64}$/i.test(tunnelKey)) throw new Error('A02_TUNNEL_KEY must be a 256-bit hex credential');
  return { mock, environment, host, base: base.href.replace(/\/$/, ''), timeoutMs,
    bearer: env.MCP_BEARER_TOKEN, token: env.CAREER_RUNTIME_TOKEN, jwks: jwks.href, tunnelKey, identityMode:'TEST_LOCAL' };
}

export function createIdentityResolver(config) {
  const cloud = config.identityMode === 'TEST_NGROK';
  const keys = config.mock ? null : cloud ? createLocalJWKSet(config.jwksDocument) : createRemoteJWKSet(new URL(config.jwks), { timeoutDuration: 5000 });
  return async authorization => {
    const expected = Buffer.from(`Bearer ${config.bearer}`);
    const supplied = Buffer.from(authorization ?? '');
    if (config.bearer && (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))) {
      throw failure('MCP_AUTHENTICATION_REQUIRED', 'Trusted caller authentication required', false, 401);
    }
    if (config.mock) return null;
    try {
      if (cloud && Date.now() >= config.deadline) throw new Error('TEST window expired');
      const { payload } = await jwtVerify(config.token, keys, { algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat', 'actor_role'],
        ...(cloud ? {issuer:config.issuer,audience:config.audience,subject:config.subject,maxTokenAge:'1h'} : {}) });
      if (cloud && (payload.iss !== config.issuer || payload.aud !== config.audience || payload.environment !== 'TEST' || payload.data_class !== 'FIXTURE' || payload.exp-payload.iat > 3600 || payload.exp<=payload.iat)) throw new Error('Invalid TEST claims');
      if (typeof payload.sub !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(payload.sub)
          || payload.actor_role !== 'PERSONAL_USER') throw new Error('invalid fixture identity');
      return Object.freeze({ token: config.token, actor: Object.freeze({ actor_id: payload.sub, actor_type: payload.actor_role }) });
    } catch {
      throw failure('MCP_IDENTITY_INVALID', 'Configured TEST identity could not be verified', false, 401);
    }
  };
}

export async function runtimeRequest(config, identity, path, init = {}) {
  if (!identity?.actor || !identity.token) throw failure('MCP_IDENTITY_REQUIRED', 'Trusted identity is required', false, 401);
  if (config.identityMode === 'TEST_NGROK') {
    const target = new URL(`${config.base}${path}`);
    if (Date.now() >= config.deadline || target.origin !== config.allowedOrigin || target.protocol !== 'https:'
        || !path.startsWith('/') || path.startsWith('//') || /[\\#\r\n]/.test(path)) throw failure('MCP_TEST_BOUNDARY_REJECTED', 'TEST network boundary rejected request', false);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const headers = new Headers(init.headers ?? {});
    headers.set('content-type', 'application/json');
    headers.set('authorization', `Bearer ${identity.token}`);
    headers.delete('x-a02-tunnel-key');
    if (config.tunnelKey) headers.set('x-a02-tunnel-key', config.tunnelKey);
    const response = await fetch(`${config.base}${path}`, { ...init, headers, signal: controller.signal, redirect: 'error' });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { throw failure('MCP_BACKEND_INVALID_RESPONSE', 'Backend did not return a JSON envelope', false, response.status); }
    if (!response.ok) {
      if (!body || body.success !== false || typeof body.error?.code !== 'string'
          || typeof body.error?.message !== 'string' || typeof body.error?.retryable !== 'boolean') {
        throw failure('MCP_BACKEND_INVALID_RESPONSE', 'Backend error envelope is invalid', false, response.status);
      }
      // Preserve authoritative fields as structure, never collapse them into a message string.
      throw new AdapterError({ ...body, http_status: response.status });
    }
    return { ...body, http_status: response.status };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    if (controller.signal.aborted) throw failure('MCP_BACKEND_TIMEOUT', 'Backend request timed out; write outcome may be unknown, read authoritative state before retrying', true);
    throw failure('MCP_BACKEND_UNAVAILABLE', 'Backend connection failed; no fallback was used', true);
  } finally { clearTimeout(timer); }
}
