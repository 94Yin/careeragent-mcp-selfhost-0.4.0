import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
const backend=resolve('../../../CarrerAgent/career-agent');
const ev=resolve(backend,'evidence/render-prepublish-20261008');
const env=p=>Object.fromEntries(readFileSync(p,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(x=>x.includes('=')).map(x=>[x.slice(0,x.indexOf('=')),x.slice(x.indexOf('=')+1)]));
const auth=env(resolve(backend,'.runtime/frontend-integration/fixture-auth.env'));
const caller=env('.runtime/render-audit-auth.env').MCP_BEARER_TOKEN;
const client=new Client({name:'render-preflight-readonly',version:'1.0'});
const save=(name,data)=>writeFileSync(resolve(ev,name),JSON.stringify(data,null,2));
try {
 const health=await(await fetch('http://127.0.0.1:13040/health')).json();assert.equal(health.version,'0.4.1');assert.equal(health.mock_mode,false);save('local-health.json',health);
 await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:13040/mcp'),{requestInit:{headers:{Authorization:`Bearer ${caller}`}}}));
 const list=await client.listTools();assert.equal(list.tools.length,5);const ajv=new Ajv({strict:false});
 const baseline=JSON.parse(readFileSync(resolve(backend,'evidence/mcp-repair-20261007/tools-list.json'),'utf8'));
 for(const t of list.tools){assert.equal(ajv.validateSchema(t.inputSchema),true);assert.deepEqual(t.inputSchema,baseline.tools.find(x=>x.name===t.name).inputSchema);assert.ok(!Object.hasOwn(t.inputSchema.properties,'actor'));}
 save('tools-list.json',list);
 const target=JSON.parse(readFileSync(resolve(backend,'evidence/same-run-20261007/summary.json'),'utf8')).TARGET_RUN_ID;
 const headers={Authorization:`Bearer ${auth.A02_FIXTURE_USER_A_JWT}`};
 const r=await fetch(`http://127.0.0.1:8080/api/v1/career/runs/${target}`,{headers});assert.equal(r.status,200);const run=await r.json();save('backend-run.json',run);
 const artifacts=[];
 for(const [type,view] of [['ProfileSnapshot','PROFILE'],['CareerRanking','CAREER_CANDIDATES'],['SkillGap','SKILL_TREE'],['SkillTree','SKILL_TREE'],['PathPlan','PATH']]){const refs=run.data.artifact_refs.filter(x=>x.type===type);assert.equal(refs.length,1);const response=await fetch(`http://127.0.0.1:8080/api/v1/artifacts/${refs[0].id}?view=${view}`,{headers});assert.equal(response.status,200);assert.equal((await response.json()).data.view_type,view);artifacts.push({type,ref:refs[0],http_status:response.status});}
 save('local-readiness.json',{tools_schema:'PASS unchanged from accepted local 0.4.1',tools:5,backend:'PASS',artifacts,target,scope:'Read-only verification of existing accepted target, not an Ant-created run'});
 console.log('PASS: MCP 0.4.1 real mode; five JSON Schemas valid and unchanged; Backend JWT and five authoritative artifacts HTTP200.');
}finally{await client.close();}
