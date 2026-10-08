import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, createIdentityResolver, runtimeRequest } from '../adapter.js';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
const jwt = async (key = privateKey, expiry = '5m', role = 'PERSONAL_USER') => new SignJWT({ actor_role: role })
  .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('controlled_user_a').setIssuedAt().setExpirationTime(expiry).sign(key);
const token = await jwt();
const credential = 'test-caller-' + globalThis.crypto.randomUUID();
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const env = (url, overrides = {}) => ({ MOCK_MODE: 'false', MCP_ENVIRONMENT: 'TEST', MCP_IDENTITY_MODE: 'TEST_LOCAL', NODE_ENV: 'test', HOST: '127.0.0.1',
  CAREER_RUNTIME_BASE_URL: `${url}/api/v1`, CAREER_RUNTIME_JWKS_URL: `${url}/jwks`, CAREER_RUNTIME_TOKEN: token, MCP_BEARER_TOKEN: credential, ...overrides });
const identity = { actor: { actor_id: 'controlled_user_a', actor_type: 'PERSONAL_USER' }, token };

test('real mode is default and fails startup without base URL', () => {
  assert.throws(() => loadConfig({}), /BASE_URL/);
  const child = spawnSync(process.execPath, ['server.js'], { env: { ...process.env, MOCK_MODE: 'false', CAREER_RUNTIME_BASE_URL: '' }, encoding: 'utf8' });
  assert.equal(child.status, 1); assert.match(child.stderr, /BASE_URL/);
});
test('mock is explicit and restricted to local TEST or DEV', () => {
  for (const overrides of [{}, { MCP_ENVIRONMENT: 'PRODUCTION' }, { MCP_ENVIRONMENT: 'TEST', NODE_ENV: 'production' }, { MCP_ENVIRONMENT: 'TEST', HOST: '0.0.0.0' }])
    assert.throws(() => loadConfig({ MOCK_MODE: 'true', ...overrides }), /Mock requires/);
  for (const environment of ['TEST', 'DEV']) assert.equal(loadConfig({ MOCK_MODE: 'true', MCP_ENVIRONMENT: environment }).mock, true);
});
test('TEST identity rejects production, public host/backend and unconfigured credentials', () => {
  for (const overrides of [{ MCP_ENVIRONMENT: 'PRODUCTION' }, { NODE_ENV: 'production' }, { HOST: '0.0.0.0' },
    { CAREER_RUNTIME_BASE_URL: 'https://example.com/api/v1' }, { MCP_BEARER_TOKEN: '' }, { CAREER_RUNTIME_TOKEN: '' }, { MCP_IDENTITY_MODE: '' }]) {
    assert.throws(() => loadConfig(env('http://127.0.0.1:9999', overrides)));
  }
});
test('JWT signature, expiry, role and caller credential are enforced', async () => {
  const jwks = await listen((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  try {
    const config = loadConfig(env(jwks.url));
    const resolver = createIdentityResolver(config);
    const result = await resolver(`Bearer ${credential}`);
    assert.deepEqual(result.actor, identity.actor);
    await assert.rejects(resolver('Bearer wrong'), e => e.envelope.http_status === 401);
    const other = await generateKeyPair('RS256');
    for (const bad of [await jwt(other.privateKey), await jwt(privateKey, -1), await jwt(privateKey, '5m', 'AUTHORIZED_OPERATOR')]) {
      await assert.rejects(createIdentityResolver({ ...config, token: bad })(`Bearer ${credential}`), e => e.envelope.error.code === 'MCP_IDENTITY_INVALID');
    }
  } finally { await jwks.close(); }
});
for (const status of [400, 401, 403, 404, 409, 500]) {
  test(`Backend ${status} preserves authoritative error structure`, async () => {
    const envelope = { success: false, request_id: `req_${status}`, error: { code: status === 409 ? 'STALE_STATE_VERSION' : `ERROR_${status}`,
      message: 'controlled backend error', retryable: status === 500, ...(status === 409 ? { expected_state_version: 2, current_state_version: 4 } : {}) } };
    let calls = 0;
    const backend = await listen((req, res) => { calls++; res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(envelope)); });
    try {
      await assert.rejects(runtimeRequest(loadConfig(env(backend.url)), identity, '/career/runs/test', { method: 'POST', body: '{}' }), e => {
        assert.deepEqual(e.envelope, { ...envelope, http_status: status }); return true;
      });
      assert.equal(calls, 1);
    } finally { await backend.close(); }
  });
}
test('backend down is explicit network failure without fixture fallback', async () => {
  const backend = await listen(() => {}); const url = backend.url; await backend.close();
  await assert.rejects(runtimeRequest(loadConfig(env(url)), identity, '/career/runs', { method: 'POST', body: '{}' }), e => e.envelope.error.code === 'MCP_BACKEND_UNAVAILABLE' && !e.envelope.data);
});
test('timeout aborts write once and is distinct from business errors', async () => {
  let calls = 0;
  const backend = await listen(() => { calls++; });
  try {
    await assert.rejects(runtimeRequest(loadConfig(env(backend.url, { CAREER_RUNTIME_TIMEOUT_MS: '50' })), identity, '/career/runs', { method: 'POST', body: '{}' }), e => e.envelope.error.code === 'MCP_BACKEND_TIMEOUT');
    assert.equal(calls, 1);
  } finally { await backend.close(); }
});
test('timeout also bounds slow response bodies', async () => {
  const backend = await listen((req, res) => { res.writeHead(200); res.write('{'); });
  try { await assert.rejects(runtimeRequest(loadConfig(env(backend.url, { CAREER_RUNTIME_TIMEOUT_MS: '50' })), identity, '/career/runs'), e => e.envelope.error.code === 'MCP_BACKEND_TIMEOUT'); }
  finally { await backend.close(); }
});
test('missing trusted identity fails before HTTP', async () => {
  await assert.rejects(runtimeRequest(loadConfig(env('http://127.0.0.1:1')), null, '/career/runs'), e => e.envelope.error.code === 'MCP_IDENTITY_REQUIRED');
});
test('malformed Backend body does not leak raw response', async () => {
  const backend = await listen((req, res) => { res.writeHead(500); res.end('private backend text'); });
  try { await assert.rejects(runtimeRequest(loadConfig(env(backend.url)), identity, '/career/runs'), e => e.envelope.error.code === 'MCP_BACKEND_INVALID_RESPONSE' && !JSON.stringify(e.envelope).includes('private backend text')); }
  finally { await backend.close(); }
});
test('real MCP transport constructs actors and preserves all write fields; spoofed actor is rejected', async () => {
  const received = [];
  const backend = await listen(async (req, res) => {
    if (req.url === '/jwks') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, method: req.method, body: raw ? JSON.parse(raw) : null, authorization: req.headers.authorization });
    res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { run_id: 'controlled_run' }, request_id: 'req_controlled' }));
  });
  const reservation = await listen(() => {}); const port = new URL(reservation.url).port; await reservation.close();
  const child = spawn(process.execPath, ['server.js'], { env: { ...process.env, ...env(backend.url), PORT: port }, stdio: 'ignore' });
  const client = new Client({ name: 'adapter-unit-tests', version: '1.0.0' });
  try {
    let ready = false; for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${port}/health`); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); } }
    assert.ok(ready);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${credential}` } } }));
    assert.equal((await client.listTools()).tools.length, 5);
    const base = { command_id: 'cmd_test', idempotency_key: 'idempotency_test' };
    const start = await client.callTool({ name: 'career_run_start', arguments: { ...base, workflow_type: 'RECOMMEND_AND_PLAN', payload_json: '{}' } });
    assert.equal(JSON.parse(start.content[0].text).http_status, 202);
    const ref = { id: 'ranking', version: 1, type: 'CareerRanking' };
    await client.callTool({ name: 'career_run_continue', arguments: { ...base, runId: 'controlled_run', action: 'CANCEL_RUN', expected_state_version: 4, subject_ref_json: JSON.stringify(ref), payload_json: '{"value":1}' } });
    await client.callTool({ name: 'career_decision_confirm', arguments: { ...base, runId: 'controlled_run', expected_state_version: 4, subject_ref_json: JSON.stringify(ref), ranking_item_id: 'item', recommendation_group: 'CURRENT_FIT' } });
    for (const request of received) { assert.deepEqual(request.body.actor, identity.actor); assert.equal(request.authorization, `Bearer ${token}`); assert.equal(request.body.idempotency_key, base.idempotency_key); assert.equal(request.body.command_id, base.command_id); }
    assert.equal(received[1].body.expected_state_version, 4); assert.equal(received[1].body.action, 'CANCEL_RUN');
    assert.deepEqual(received[1].body.subject_ref, ref); assert.deepEqual(received[1].body.payload, { value: 1 });
    assert.equal(received[2].body.action, 'CONFIRM_CAREER_TARGET'); assert.deepEqual(received[2].body.payload, { ranking_item_id: 'item', recommendation_group: 'CURRENT_FIT' });
    const spoof = await client.callTool({ name: 'career_run_start', arguments: { ...base, workflow_type: 'PROFILE_BUILD', payload_json: '{}', actor: { actor_id: 'attacker' } } });
    assert.equal(spoof.isError, true); assert.equal(received.length, 3);
  } finally { await client.close().catch(() => {}); child.kill(); await backend.close(); }
});
