import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runtimeRequest} from '../adapter.js';
const root=resolve('../../../CarrerAgent/career-agent'),ev=resolve(root,'evidence/windows-gateway-20261008');
const env=p=>Object.fromEntries(readFileSync(p,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
const auth=env(resolve(root,'.runtime/frontend-integration/fixture-auth.env')),f=env(resolve(root,'.runtime/frontend-integration/fixture.env'));
const {key}=JSON.parse(readFileSync('.runtime/tunnel-gateway.json','utf8'));
const child=spawn(process.execPath,['gateway/server.mjs'],{stdio:['ignore','pipe','pipe'],windowsHide:true});let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);const records=[];
async function req(path,status,{secret=key,token=auth.A02_FIXTURE_USER_A_JWT,body,direct=false}={}){const headers={};if(secret)headers['X-A02-Tunnel-Key']=secret;if(token)headers.Authorization=`Bearer ${token}`;if(body)headers['content-type']='application/json';const r=await fetch(`http://127.0.0.1:${direct?8080:18080}${path}`,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});const response=await r.json();records.push({path,status:r.status,response,direct});writeFileSync(resolve(ev,'live-trace.json'),JSON.stringify(records,null,2));assert.equal(r.status,status);return response;}
try{
 for(let i=0;i<40&&!logs.includes('listening');i++){if(child.exitCode!==null)throw new Error('Gateway startup failed');await new Promise(r=>setTimeout(r,100));}assert.ok(logs.includes('listening'));
 const path=`/api/v1/career/runs/${f.USER_A_RUN_ID}`;
 await req(path,403,{secret:null});await req(path,403,{secret:'wrong'});await req(path,401,{token:'invalid.jwt'});await req(path,401,{token:null});
 const a=await req(path,200),b=await req(path,200,{direct:true});assert.deepEqual(a.data,b.data);
 await req(path,403,{token:auth.A02_FIXTURE_USER_B_JWT});await req(`/api/v1/artifacts/${f.PROFILE_ARTIFACT_ID}?view=PROFILE`,403,{token:auth.A02_FIXTURE_USER_B_JWT});
 for(const p of ['/actuator','/admin','/.well-known/jwks.json','/private.key','/api/v1/career/runs/a?url=http://evil'])await req(p,404);
 const stale=await req(`/api/v1/career/runs/${f.DECISION_RUN_ID}/career-decisions`,409,{body:{command_id:randomUUID(),idempotency_key:randomUUID(),actor:{actor_id:f.USER_A_ID,actor_type:'PERSONAL_USER'},action:'CONFIRM_CAREER_TARGET',expected_state_version:1,subject_ref:{id:f.DECISION_RANKING_ID,version:1,type:'CareerRanking'},payload:{ranking_item_id:f.DECISION_RANKING_ITEM_ID,recommendation_group:f.DECISION_RANKING_GROUP}}});assert.equal(stale.error.code,'STALE_STATE_VERSION');assert.ok(stale.request_id);
 const error=await req(`/api/v1/career/runs/${f.E2E_500_THEN_RECOVER_RUN_ID_TABLET}`,500);assert.equal(error.error.code,'INTERNAL_ERROR');assert.equal(error.error.retryable,true);assert.ok(error.request_id);await req(`/api/v1/career/runs/${f.E2E_500_THEN_RECOVER_RUN_ID_TABLET}`,200);
 const viaAdapter=await runtimeRequest({base:'http://127.0.0.1:18080/api/v1',timeoutMs:10000,tunnelKey:key},{actor:{actor_id:f.USER_A_ID},token:auth.A02_FIXTURE_USER_A_JWT},`/career/runs/${f.USER_A_RUN_ID}`);assert.deepEqual(viaAdapter.data,a.data);
 assert.ok(!logs.includes(key));assert.ok(!logs.includes(auth.A02_FIXTURE_USER_A_JWT));
}finally{child.kill();await new Promise(r=>child.once('close',r));writeFileSync(resolve(ev,'gateway.log'),logs);}
await req(`/api/v1/career/runs/${f.USER_A_RUN_ID}`,200,{direct:true});
writeFileSync(resolve(ev,'live-summary.json'),JSON.stringify({status:'LOCAL_GATEWAY_PASS',requests:records.length,backendAfterGatewayStopped:'HTTP200',ngrok:'NOT_STARTED; stop scenario NOT_RUN',source:'real Spring/JWT/MySQL, no synthetic response'},null,2));console.log('PASS: real JWT401/owner403/business200/stale409/500 recovery; outbound adapter; Backend HTTP200 after gateway stopped.');
