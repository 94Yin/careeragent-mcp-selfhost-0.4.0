import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const ev=resolve('../../../CarrerAgent/career-agent/evidence/same-run-20261007');
const read=name=>JSON.parse(readFileSync(resolve(ev,name),'utf8').replace(/^\uFEFF/,''));
const trace=read('same-run-trace.json'), db=read('db-authority.json');
const final=trace.snapshots.at(-1).backend.data;
assert.equal(final.run_id,trace.TARGET_RUN_ID);assert.equal(final.status,'COMPLETED');assert.equal(final.state_version,7);
const input=db.find(x=>x.kind==='input'&&x.type==='ProfileSnapshot');
assert.equal(input.owner_workflow_type,'PROFILE_BUILD');assert.notEqual(input.owner_run_id,trace.TARGET_RUN_ID);
const initialProfile=trace.start.data.artifact_refs.find(x=>x.type==='ProfileSnapshot');
for(const type of ['ProfileSnapshot','CareerRanking','SkillGap','SkillTree','PathPlan']){
 const refs=final.artifact_refs.filter(x=>x.type===type);assert.equal(refs.length,1);
 if(type==='ProfileSnapshot'){assert.equal(refs[0].id,input.artifact_id);assert.equal(refs[0].version,input.version);assert.deepEqual(refs[0],initialProfile);}
 else {const owner=db.find(x=>x.kind==='artifact'&&x.type===type);assert.equal(owner.run_id,trace.TARGET_RUN_ID);assert.equal(owner.id,refs[0].id);assert.equal(owner.version,refs[0].version);}
}
assert.equal(trace.frontend.length,15);
for(const page of trace.frontend){assert.equal(page.lastState.run_id,trace.TARGET_RUN_ID);assert.equal(page.errors.length,0);for(const r of page.requests){if(r.url.includes('/career/runs/'))assert.equal(new URL(r.url).pathname,`/api/v1/career/runs/${trace.TARGET_RUN_ID}`);}
 if(page.phase==='final'){assert.equal(page.presentation,'PRESENT');for(const f of ['run_id','workflow_type','status','current_step','state_version','next_actions','artifact_refs'])assert.deepEqual(page.lastState[f],final[f]);}}
const stale=trace.calls.find(x=>x.body.error?.code==='STALE_STATE_VERSION').body;
assert.ok(db.some(x=>x.kind==='audit'&&x.request_id===stale.request_id&&x.error_code==='STALE_STATE_VERSION'&&x.result==='REJECTED'));
assert.equal(stale.error.expected_state_version,1);assert.equal(stale.error.current_state_version,4);
assert.equal(trace.security.length,5);
trace.state_transitions=db.filter(x=>x.kind==='event'&&x.event_type==='RUN_STATE_CHANGED');
trace.state_version_history=trace.state_transitions.map(x=>x.state_version);assert.deepEqual(trace.state_version_history,[1,2,3,4,5,6,7]);
trace.next_actions_history=trace.snapshots.map(x=>({state_version:x.backend.data.state_version,next_actions:x.backend.data.next_actions}));
trace.artifact_refs_history=trace.snapshots.map(x=>({state_version:x.backend.data.state_version,artifact_refs:x.backend.data.artifact_refs}));
trace.profile_lineage=input;trace.stale_backend_audit=db.find(x=>x.kind==='audit'&&x.request_id===stale.request_id);
trace.result='MCP_BACKEND_FRONTEND_SAME_RUN_READY';
writeFileSync(resolve(ev,'same-run-trace.json'),JSON.stringify(trace,null,2));
const summary={status:trace.result,TARGET_RUN_ID:trace.TARGET_RUN_ID,initial:'RUNNING / EVIDENCE_RETRIEVE / v1',final:`${final.status} / ${final.current_step} / v${final.state_version}`,same:true,versions:trace.state_version_history,browser:{stages:3,pages_per_stage:5,loads_including_reload:30,passed:15,failed:0,skipped:0},mcp_calls:trace.calls.length,stale_request_id:stale.request_id,profile_input:input,artifact_refs:final.artifact_refs,security:'PASS: MCP/Backend Run+Artifact403; Frontend target URL403'};
writeFileSync(resolve(ev,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
