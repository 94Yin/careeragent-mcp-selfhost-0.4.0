// Real Spring/JWT/MySQL acceptance. No HTTP stubs, interception or mock runtime.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root = resolve('../../../CarrerAgent/career-agent');
const envFile = path => Object.fromEntries(readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=')+1)]));
const fixture = envFile(resolve(root, '.runtime/frontend-integration/fixture.env'));
const auth = envFile(resolve(root, '.runtime/frontend-integration/fixture-auth.env'));
const mcpAuth = envFile(resolve('.runtime/mcp-auth.env'));
const evidence = resolve(root, 'evidence/mcp-repair-20261007'); mkdirSync(evidence, { recursive: true });
const backend = 'http://127.0.0.1:8080/api/v1';
const mcp = 'http://127.0.0.1:13040';
const headers = { Authorization: `Bearer ${auth.A02_FIXTURE_USER_A_JWT}` };
const client = new Client({ name: 'careeragent-real-backend-acceptance', version: '1.0.0' });
const records = [];
const save = () => writeFileSync(resolve(evidence, 'real-tool-trace.json'), JSON.stringify(records, null, 2));
async function tool(name, args, expectedStatus) {
  const result = await client.callTool({ name, arguments: args });
  const envelope = JSON.parse(result.content[0].text);
  records.push({ tool: name, arguments: args, isError: result.isError === true, response: envelope }); save();
  assert.equal(envelope.http_status, expectedStatus, `${name}: expected HTTP ${expectedStatus}, got ${envelope.http_status} (${envelope.error?.code || ''})`);
  assert.equal(result.isError === true, expectedStatus >= 400);
  return envelope;
}
async function direct(path) {
  const response = await fetch(`${backend}${path}`, { headers }); assert.equal(response.status, 200);
  return (await response.json()).data;
}
const sameFields = ['run_id', 'workflow_type', 'status', 'current_step', 'state_version', 'next_actions', 'artifact_refs'];
function same(a, b) { for (const key of sameFields) assert.deepEqual(a[key], b[key], key); }
const command = label => ({ command_id: `mcp_${label}_${randomUUID()}`, idempotency_key: `mcp_${label}_${randomUUID()}` });
try {
  const health = await (await fetch(`${mcp}/health`)).json();
  assert.equal(health.mock_mode, false); assert.equal(health.identity_mode, 'TEST_LOCAL');
  writeFileSync(resolve(evidence, 'mcp-health.json'), JSON.stringify(health, null, 2));
  await client.connect(new StreamableHTTPClientTransport(new URL(`${mcp}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpAuth.MCP_BEARER_TOKEN}` } } }));
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(t => t.name).sort(), ['artifact_get','career_decision_confirm','career_run_continue','career_run_start','career_run_status']);
  writeFileSync(resolve(evidence, 'tools-list.json'), JSON.stringify(listed, null, 2));
  const startArgs = { ...command('start'), workflow_type: 'RECOMMEND_AND_PLAN', payload_json: '{}' };
  const started = (await tool('career_run_start', startArgs, 202)).data;
  const backendRun = await direct(`/career/runs/${started.run_id}`);
  same(started, backendRun);
  const status = (await tool('career_run_status', { runId: started.run_id }, 200)).data;
  same(status, backendRun);
  same((await tool('career_run_start', startArgs, 202)).data, started);
  writeFileSync(resolve(evidence, 'same-runtime-proof.json'), JSON.stringify({ start_arguments: startArgs, mcp_start: started, backend_get: backendRun, mcp_status: status, same: true }, null, 2));

  const read = (await tool('career_run_status', { runId: fixture.USER_A_RUN_ID }, 200)).data;
  same(read, await direct(`/career/runs/${fixture.USER_A_RUN_ID}`));
  for (const [type, view, key] of [['ProfileSnapshot','PROFILE','PROFILE_ARTIFACT_ID'],['CareerRanking','CAREER_CANDIDATES','RANKING_ID'],
    ['SkillGap','SKILL_TREE','SKILL_GAP_ID'],['SkillTree','SKILL_TREE','SKILL_TREE_ID'],['PathPlan','PATH','PATH_PLAN_ID']]) {
    const refs = read.artifact_refs.filter(ref => ref.type === type); assert.equal(refs.length, 1); assert.equal(refs[0].id, fixture[key]);
    const artifact = (await tool('artifact_get', { artifactId: refs[0].id, view }, 200)).data;
    assert.equal(artifact.view_type, view); assert.deepEqual(artifact, await direct(`/artifacts/${refs[0].id}?view=${view}`));
  }

  const freshDecision = await direct(`/career/runs/${fixture.DECISION_RUN_ID}`);
  assert.equal(freshDecision.status, 'WAITING_USER'); assert.equal(freshDecision.current_step, 'CAREER_CONFIRM');
  assert.ok(freshDecision.next_actions.includes('CONFIRM_CAREER_TARGET'));
  const decisionArgs = { ...command('decision'), runId: fixture.DECISION_RUN_ID, expected_state_version: freshDecision.state_version,
    subject_ref_json: JSON.stringify({ id: fixture.DECISION_RANKING_ID, version: Number(fixture.DECISION_RANKING_VERSION), type: 'CareerRanking' }),
    ranking_item_id: fixture.DECISION_RANKING_ITEM_ID, recommendation_group: fixture.DECISION_RANKING_GROUP };
  const stale = await tool('career_decision_confirm', { ...decisionArgs, ...command('stale'), expected_state_version: freshDecision.state_version-1 }, 409);
  assert.equal(stale.error.code, 'STALE_STATE_VERSION'); assert.equal(stale.error.expected_state_version, freshDecision.state_version-1);
  assert.equal(stale.error.current_state_version, freshDecision.state_version); assert.ok(stale.request_id);
  const confirmed = (await tool('career_decision_confirm', decisionArgs, 202)).data;
  assert.equal(confirmed.state_version, freshDecision.state_version+1);
  same((await tool('career_decision_confirm', decisionArgs, 202)).data, confirmed);
  const mismatch = await tool('career_decision_confirm', { ...decisionArgs, ranking_item_id: decisionArgs.ranking_item_id+'_different' }, 409);
  assert.equal(mismatch.error.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  same((await tool('career_run_status', { runId: decisionArgs.runId }, 200)).data, await direct(`/career/runs/${decisionArgs.runId}`));

  // Separate controlled PROFILE_BUILD run exercises a genuine advertised continue action.
  // Do not fabricate completion or alter the RECOMMEND_AND_PLAN worker boundary above.
  const profile = (await tool('career_run_start', { ...command('profile'), workflow_type: 'PROFILE_BUILD', payload_json: '{}' }, 202)).data;
  assert.equal(profile.status, 'WAITING_USER'); assert.ok(profile.next_actions.includes('CANCEL_RUN'));
  const continued = (await tool('career_run_continue', { ...command('continue'), runId: profile.run_id, expected_state_version: profile.state_version,
    action: 'CANCEL_RUN', payload_json: '{}' }, 202)).data;
  assert.equal(continued.state_version, profile.state_version+1);
  same(continued, await direct(`/career/runs/${profile.run_id}`));
  same((await tool('career_run_status', { runId: profile.run_id }, 200)).data, continued);
  const bad = await tool('career_run_continue', { ...command('invalid'), runId: profile.run_id, expected_state_version: 0, action: 'NOT_REGISTERED', payload_json: '{}' }, 400);
  assert.equal(bad.error.code, 'VALIDATION_FAILED');
  await tool('career_run_status', { runId: fixture.USER_B_RUN_ID }, 403);
  await tool('artifact_get', { artifactId: fixture.USER_B_ARTIFACT_ID, view: 'PROFILE' }, 403);
  await tool('career_run_status', { runId: `missing_${randomUUID()}` }, 404);
  const recovery = fixture.E2E_500_THEN_RECOVER_RUN_ID_DESKTOP;
  const failed = await tool('career_run_status', { runId: recovery }, 500);
  assert.equal(failed.error.code, 'INTERNAL_ERROR'); assert.equal(failed.error.retryable, true); assert.ok(failed.request_id);
  await tool('career_run_status', { runId: recovery }, 200);
  writeFileSync(resolve(evidence, 'fixture-metadata.json'), JSON.stringify(fixture, null, 2));
  const result = { status: 'MCP_REAL_BACKEND_READY', tools: listed.tools.map(t => t.name), calls: records.length, same_run_id: started.run_id,
    recommend_state: started.status, recommend_step: started.current_step, continue_run_id: profile.run_id, continue_action: 'CANCEL_RUN',
    decision_run_id: decisionArgs.runId, decision_version_before: freshDecision.state_version, decision_version_after: confirmed.state_version,
    artifact_source_run: fixture.USER_A_RUN_ID, stale, identity: 'TEST_LOCAL verified RS256 JWT', mock: false, backend,
    note: 'No Ant or Frontend same-run acceptance claimed. Five artifacts came from freshly seeded READ run, not from the just-started recommendation run.' };
  writeFileSync(resolve(evidence, 'real-smoke-summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await client.close(); }
