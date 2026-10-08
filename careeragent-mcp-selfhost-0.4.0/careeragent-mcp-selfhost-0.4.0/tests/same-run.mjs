import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root = resolve('../../../CarrerAgent/career-agent');
const ev = resolve(root, 'evidence/same-run-20261007');
const env = p => Object.fromEntries(readFileSync(p,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x && !x.startsWith('#') && x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
const auth=env(resolve(root,'.runtime/frontend-integration/fixture-auth.env'));
const fixture=env(resolve(root,'.runtime/frontend-integration/fixture.env'));
const file=resolve(ev,'same-run-trace.json');
const phase=process.argv[2];
const trace=phase==='init'?{TARGET_RUN_ID:null,calls:[],snapshots:[],frontend:[],security:[]}:JSON.parse(readFileSync(file,'utf8'));
const save=()=>writeFileSync(file,JSON.stringify(trace,null,2));
const fields=['run_id','workflow_type','status','current_step','state_version','next_actions','artifact_refs'];
const compare=(a,b)=>{for(const f of fields)assert.deepEqual(a[f],b[f],f);};
const clients=[];
async function connect(user='A') {const c=new Client({name:'same-run-acceptance',version:'1.0'}); const key=env(resolve(`.runtime/same-run-auth-${user}.env`)).MCP_BEARER_TOKEN;await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${user==='A'?13040:13041}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${key}`}}}));clients.push(c);return c;}
const command=()=>({command_id:`same_${randomUUID()}`,idempotency_key:`same_${randomUUID()}`});
async function tool(c,name,args,status=200){const r=await c.callTool({name,arguments:args});const body=JSON.parse(r.content[0].text);trace.calls.push({time:new Date().toISOString(),name,args,body});save();assert.equal(body.http_status,status,JSON.stringify(body));return body;}
async function http(path,user='A',status=200){const r=await fetch(`http://127.0.0.1:8080/api/v1${path}`,{headers:{Authorization:`Bearer ${auth[`A02_FIXTURE_USER_${user}_JWT`]}`}});const body=await r.json();assert.equal(r.status,status,JSON.stringify(body));return body;}
async function snapshot(c,label){const m=await tool(c,'career_run_status',{runId:trace.TARGET_RUN_ID});const b=await http(`/career/runs/${trace.TARGET_RUN_ID}`);compare(m.data,b.data);trace.snapshots.push({label,time:new Date().toISOString(),mcp:m,backend:b});save();return b.data;}
const views=[['/profile','profile-page','ProfileSnapshot','PROFILE'],['/careers','careers-page','CareerRanking','CAREER_CANDIDATES'],['/skills','skills-page','SkillGap','SKILL_TREE'],['/skill-tree','skill-tree-page','SkillTree','SKILL_TREE'],['/path','path-page','PathPlan','PATH']];
try {
 const c=await connect();
 if(phase==='init'){
  const start=await tool(c,'career_run_start',{...command(),workflow_type:'RECOMMEND_AND_PLAN',payload_json:'{}'},202);
  trace.TARGET_RUN_ID=start.data.run_id;trace.start=start;save();compare(start.data,await snapshot(c,'initial'));
  writeFileSync(resolve(ev,'fixture-metadata.json'),JSON.stringify(fixture,null,2));
  writeFileSync(resolve(root,'frontend/.env.e2e'),`E2E_WEB_BASE_URL=http://127.0.0.1:5173\nE2E_RUN_ID=${trace.TARGET_RUN_ID}\nE2E_USER_A_JWT=${auth.A02_FIXTURE_USER_A_JWT}\nE2E_USER_A_ACTOR_ID=${fixture.USER_A_ID}\nE2E_USER_B_JWT=${auth.A02_FIXTURE_USER_B_JWT}\nE2E_EXPIRED_JWT=${auth.A02_FIXTURE_EXPIRED_JWT||auth.A02_FIXTURE_EXPIRED_USER_A_JWT||''}\n`);
 } else if(phase==='poll'){
  for(let i=0;i<20;i++){const run=await snapshot(c,`worker-poll-${i}`);if(run.status!=='RUNNING')break;await new Promise(r=>setTimeout(r,2000));}
 } else if(phase==='decision'){
  const run=await snapshot(c,'before-decision');assert.equal(run.current_step,'CAREER_CONFIRM');assert.ok(run.next_actions.includes('CONFIRM_CAREER_TARGET'));
  const ref=run.artifact_refs.find(r=>r.type==='CareerRanking');assert.ok(ref);
  const a=(await tool(c,'artifact_get',{artifactId:ref.id,view:'CAREER_CANDIDATES'})).data;
  writeFileSync(resolve(ev,'target-ranking.json'),JSON.stringify(a,null,2));
  // Selection is supplied from the authoritative view, never from fixture IDs.
  console.log(JSON.stringify({ranking:ref,view:a},null,2));
 } else if(phase==='confirm'){
  const run=await snapshot(c,'confirm-latest');assert.ok(run.next_actions.includes('CONFIRM_CAREER_TARGET'));
  const ref=run.artifact_refs.find(r=>r.type==='CareerRanking');const selection=JSON.parse(readFileSync(resolve(ev,'target-selection.json'),'utf8'));
  const args={...command(),runId:run.run_id,expected_state_version:run.state_version,subject_ref_json:JSON.stringify({id:ref.id,version:ref.version,type:ref.type}),...selection};
  const stale=await tool(c,'career_decision_confirm',{...args,...command(),expected_state_version:trace.start.data.state_version},409);
  assert.equal(stale.error.code,'STALE_STATE_VERSION');assert.equal(stale.error.current_state_version,run.state_version);assert.ok(stale.request_id);
  trace.decision=await tool(c,'career_decision_confirm',args,202);assert.equal(trace.decision.data.state_version,run.state_version+1);save();await snapshot(c,'after-decision');
 } else if(phase==='artifacts'){
  const run=await snapshot(c,'final');trace.artifacts=[];
  for(const [, ,type,view] of views){const refs=run.artifact_refs.filter(r=>r.type===type);assert.equal(refs.length,1);const ref=refs[0];const m=await tool(c,'artifact_get',{artifactId:ref.id,view});const b=await http(`/artifacts/${ref.id}?view=${view}`);assert.deepEqual(m.data,b.data);trace.artifacts.push({type,ref,mcp:m,backend:b});save();}
  const cb=await connect('B');
  for(const [name,args,path] of [['career_run_status',{runId:run.run_id},`/career/runs/${run.run_id}`],['artifact_get',{artifactId:run.artifact_refs.find(r=>r.type==='CareerRanking').id,view:'CAREER_CANDIDATES'},`/artifacts/${run.artifact_refs.find(r=>r.type==='CareerRanking').id}?view=CAREER_CANDIDATES`]]){trace.security.push({name,mcp:await tool(cb,name,args,403),backend:await http(path,'B',403)});save();}
 } else if(phase==='browser'){
  const {chromium}=await import(new URL(`file:///${resolve(root,'frontend/node_modules/playwright/index.mjs').replaceAll('\\','/')}`));
  const browser=await chromium.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000}});
   await context.addInitScript(({token,run})=>{localStorage.setItem('career_access_token',token);localStorage.setItem('career_run_id',run);},{token:auth.A02_FIXTURE_USER_A_JWT,run:trace.TARGET_RUN_ID});
   for(const [path,marker,type,view] of views){const page=await context.newPage();const entry={phase:process.argv[3]||'final',path,requests:[],responses:[],errors:[]};const pending=[];
    page.on('request',r=>{if(r.url().includes('/api/v1/'))entry.requests.push({method:r.method(),url:r.url()});});
    page.on('response',r=>{if(r.url().includes('/api/v1/'))pending.push((async()=>{entry.responses.push({url:r.url(),status:r.status(),body:await r.json()});})());});
    page.on('pageerror',e=>entry.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')entry.errors.push(m.text());});
    for(const reload of [false,true]){const wait=page.waitForResponse(r=>r.url().endsWith(`/career/runs/${trace.TARGET_RUN_ID}`));if(reload)await page.reload();else await page.goto(`http://127.0.0.1:5173${path}`);const r=await wait;assert.equal(r.status(),200);const state=(await r.json()).data;compare(state,(await http(`/career/runs/${trace.TARGET_RUN_ID}`)).data);const ref=state.artifact_refs.find(r=>r.type===type);
     await page.getByTestId(ref?marker:'page-empty').waitFor({state:'visible'});await page.waitForTimeout(150);await Promise.all(pending);
     for(const a of entry.responses.filter(x=>x.url.includes('/artifacts/'))){assert.equal(a.status,200);const id=decodeURIComponent(new URL(a.url).pathname.split('/').at(-1));assert.ok(state.artifact_refs.some(x=>x.id===id));assert.equal(a.body.data.view_type,view);}
     if(ref)assert.ok(entry.responses.some(x=>x.url.includes(`/artifacts/${ref.id}?`)));else assert.equal(entry.responses.filter(x=>x.url.includes('/artifacts/')).length,0);
     entry.lastState=state;entry.presentation=ref?'PRESENT':'NOT_YET_GENERATED';
    }
    assert.deepEqual(entry.errors,[]);await page.screenshot({path:resolve(ev,`${entry.phase}-${marker}.png`),fullPage:true});trace.frontend.push(entry);save();await page.close();
   }
   const other=await browser.newContext();await other.addInitScript(({token,run})=>{localStorage.setItem('career_access_token',token);localStorage.setItem('career_run_id',run);},{token:auth.A02_FIXTURE_USER_B_JWT,run:trace.TARGET_RUN_ID});const page=await other.newPage();const denied=page.waitForResponse(r=>r.url().endsWith(`/career/runs/${trace.TARGET_RUN_ID}`));await page.goto('http://127.0.0.1:5173/profile');const response=await denied;assert.equal(response.status(),403);await page.getByTestId('page-error').waitFor({state:'visible'});trace.security.push({name:'Frontend User B target URL',url:response.url(),status:response.status(),body:await response.json()});save();await page.screenshot({path:resolve(ev,`${process.argv[3]||'final'}-cross-user.png`)});
  }finally{await browser.close();}
 } else throw new Error('Unknown phase');
 console.log(JSON.stringify({phase,TARGET_RUN_ID:trace.TARGET_RUN_ID,result:'PASS',latest:trace.snapshots.at(-1)?.backend.data.status}));
}finally{save();await Promise.all(clients.map(c=>c.close()));}
