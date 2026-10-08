import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {loadConfig,createIdentityResolver,runtimeRequest} from '../adapter.js';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Ajv from 'ajv';
const pair=await generateKeyPair('RS256');
const jwk={...await exportJWK(pair.publicKey),kid:'candidate-test',alg:'RS256',use:'sig'};
const bytes=JSON.stringify({keys:[jwk]});
const dir=mkdtempSync(join(tmpdir(),'a02-public-jwks-'));const file=join(dir,'public.json');writeFileSync(file,bytes);
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const caller=randomBytes(32).toString('hex'),key=randomBytes(32).toString('hex');
const issue=async(claims={},signing=pair.privateKey)=>new SignJWT({actor_role:'PERSONAL_USER',environment:'TEST',data_class:'FIXTURE',...claims})
 .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(claims.iss??'urn:a02:careeragent:test').setAudience(claims.aud??'urn:a02:careeragent:backend:test')
 .setSubject(claims.sub??'frontend_fixture_user_a').setIssuedAt(claims.iat??Math.floor(Date.now()/1000)).setExpirationTime(claims.exp??'10m').sign(signing);
const token=await issue();
const env=(extra={})=>({MOCK_MODE:'false',MCP_ENVIRONMENT:'TEST',MCP_DATA_CLASS:'FIXTURE',MCP_IDENTITY_MODE:'TEST_NGROK',NODE_ENV:'test',HOST:'0.0.0.0',
 CAREER_RUNTIME_BASE_URL:'https://controlled.ngrok-free.app/api/v1',CAREER_RUNTIME_ALLOWED_ORIGIN:'https://controlled.ngrok-free.app',A02_TUNNEL_KEY:key,
 CAREER_RUNTIME_TOKEN:token,MCP_BEARER_TOKEN:caller,MCP_TEST_SUBJECT:'frontend_fixture_user_a',MCP_TEST_EXPIRES_AT:new Date(Date.now()+3600000).toISOString(),
 A02_TEST_JWKS_FILE:file,A02_TEST_JWKS_SHA256:createHash('sha256').update(bytes).digest('hex'),...extra});
test('TEST_NGROK valid pinned public key and verified fixture actor',async()=>{const config=loadConfig(env());const identity=await createIdentityResolver(config)(`Bearer ${caller}`);assert.deepEqual(identity.actor,{actor_id:'frontend_fixture_user_a',actor_type:'PERSONAL_USER'});assert.equal(identity.token,token);});
for(const [name,override] of Object.entries({
 mock:{MOCK_MODE:'true'},environment:{MCP_ENVIRONMENT:'PRODUCTION'},nodeProduction:{NODE_ENV:'production'},data:{MCP_DATA_CLASS:'PRODUCTION'},
 missingKey:{A02_TUNNEL_KEY:''},weakKey:{A02_TUNNEL_KEY:'weak'},http:{CAREER_RUNTIME_BASE_URL:'http://controlled.ngrok-free.app/api/v1'},
 differentOrigin:{CAREER_RUNTIME_BASE_URL:'https://other.ngrok-free.app/api/v1'},wildcard:{CAREER_RUNTIME_ALLOWED_ORIGIN:'https://*.ngrok-free.app'},
 originPath:{CAREER_RUNTIME_ALLOWED_ORIGIN:'https://controlled.ngrok-free.app/'},local:{CAREER_RUNTIME_ALLOWED_ORIGIN:'https://localhost'},
 query:{CAREER_RUNTIME_BASE_URL:'https://controlled.ngrok-free.app/api/v1?redirect=evil'},externalJwks:{CAREER_RUNTIME_JWKS_URL:'https://evil/jwks'},
 pin:{A02_TEST_JWKS_SHA256:'0'.repeat(64)},missingFile:{A02_TEST_JWKS_FILE:'missing-public-file'},subject:{MCP_TEST_SUBJECT:'real_ant_user'},
 expiredWindow:{MCP_TEST_EXPIRES_AT:'2020-01-01'},unboundedWindow:{MCP_TEST_EXPIRES_AT:'2099-01-01'},missingCaller:{MCP_BEARER_TOKEN:''}
}))test(`TEST_NGROK rejects ${name}`,()=>assert.throws(()=>loadConfig(env(override))));
for(const [name,claims] of Object.entries({issuer:{iss:'evil'},audience:{aud:'other'},subject:{sub:'frontend_fixture_user_b'},role:{actor_role:'ADMIN'},expired:{exp:1},future:{iat:Math.floor(Date.now()/1000)+300},environment:{environment:'PRODUCTION'},data:{data_class:'LIVE'},longLife:{exp:'2h'}}))test(`cloud JWT rejects ${name}`,async()=>{const jwt=await issue(claims);await assert.rejects(createIdentityResolver(loadConfig(env({CAREER_RUNTIME_TOKEN:jwt})))(`Bearer ${caller}`),e=>e.envelope.error.code==='MCP_IDENTITY_INVALID');});
test('cloud JWT rejects wrong signature, malformed token and unauthenticated caller',async()=>{const other=await generateKeyPair('RS256');for(const jwt of [await issue({},other.privateKey),'bad.jwt'])await assert.rejects(createIdentityResolver(loadConfig(env({CAREER_RUNTIME_TOKEN:jwt})))(`Bearer ${caller}`));await assert.rejects(createIdentityResolver(loadConfig(env()))('Bearer wrong'));});
test('private-key fields rejected even if digest matches',()=>{const content=JSON.stringify({keys:[{...jwk,d:'forbidden'}]});const p=join(dir,'rejected-private-field.json');writeFileSync(p,content);assert.throws(()=>loadConfig(env({A02_TEST_JWKS_FILE:p,A02_TEST_JWKS_SHA256:createHash('sha256').update(content).digest('hex')})),/public-only/);});
test('cloud boundary rejects tampered target before issuing a request',async()=>{const cfg=loadConfig(env());const identity=await createIdentityResolver(cfg)(`Bearer ${caller}`);await assert.rejects(runtimeRequest({...cfg,base:'https://evil/api/v1'},identity,'/career/runs/a'),e=>e.envelope.error.code==='MCP_TEST_BOUNDARY_REJECTED');});
test('cloud transport adds only configured tunnel header and preserves409 without replay',async()=>{const cfg=loadConfig(env());const identity=await createIdentityResolver(cfg)(`Bearer ${caller}`);let calls=0;const original=globalThis.fetch;globalThis.fetch=async(url,init)=>{calls++;assert.equal(new URL(url).origin,cfg.allowedOrigin);assert.equal(init.redirect,'error');assert.equal(init.headers.get('X-A02-Tunnel-Key'),key);assert.equal(init.headers.get('Authorization'),`Bearer ${token}`);return new Response(JSON.stringify({success:false,error:{code:'STALE_STATE_VERSION',message:'stale',retryable:false,expected_state_version:1,current_state_version:4},request_id:'cloud-test-request'}),{status:409});};try{await assert.rejects(runtimeRequest(cfg,identity,'/career/runs/a/actions',{method:'POST',body:'{}',headers:{'X-A02-Tunnel-Key':'spoof'}}),e=>e.envelope.http_status===409&&e.envelope.error.current_state_version===4&&e.envelope.request_id==='cloud-test-request');assert.equal(calls,1);}finally{globalThis.fetch=original;}});
test('cloud write timeout aborts once, no replay or fallback',async()=>{const cfg=loadConfig(env({CAREER_RUNTIME_TIMEOUT_MS:'20'}));const identity=await createIdentityResolver(cfg)(`Bearer ${caller}`);let calls=0;const original=globalThis.fetch;globalThis.fetch=async(url,init)=>{calls++;return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('abort'))));};try{await assert.rejects(runtimeRequest(cfg,identity,'/career/runs',{method:'POST',body:'{}'}),e=>e.envelope.error.code==='MCP_BACKEND_TIMEOUT');assert.equal(calls,1);}finally{globalThis.fetch=original;}});
test('TEST_NGROK real MCP transport: five frozen schemas, verified identity, actor spoof rejected',async()=>{
 const allocator=http.createServer();await new Promise(r=>allocator.listen(0,'127.0.0.1',r));const port=allocator.address().port;await new Promise(r=>allocator.close(r));
 const child=spawn(process.execPath,['server.js'],{env:{...process.env,...env({HOST:'127.0.0.1',PORT:String(port),CAREER_RUNTIME_JWKS_URL:''})},stdio:['ignore','pipe','pipe'],windowsHide:true});let ready=false;child.stdout.on('data',b=>{if(String(b).includes('listening'))ready=true;});child.stderr.on('data',()=>{});
 const c=new Client({name:'cloud-local-security-test',version:'1'});
 try{for(let i=0;i<100&&!ready;i++){assert.equal(child.exitCode,null);await new Promise(r=>setTimeout(r,30));}assert.ok(ready);
  const health=await(await fetch(`http://127.0.0.1:${port}/health`)).json();assert.equal(health.identity_mode,'TEST_NGROK');assert.equal(health.mock_mode,false);
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${caller}`}}}));
  const listed=await c.listTools();const accepted=JSON.parse(readFileSync('tests/frozen-tools.json','utf8'));assert.equal(listed.tools.length,5);const ajv=new Ajv({strict:false});
  for(const t of listed.tools){assert.equal(ajv.validateSchema(t.inputSchema),true);assert.deepEqual(t.inputSchema,accepted.tools.find(x=>x.name===t.name).inputSchema);}
  const result=await c.callTool({name:'career_run_start',arguments:{command_id:'c',idempotency_key:'i',workflow_type:'RECOMMEND_AND_PLAN',actor:{actor_id:'victim',actor_type:'ADMIN'}}});assert.equal(result.isError,true);assert.equal(JSON.parse(result.content[0].text).error.code,'MCP_INVALID_ARGUMENT');
 }finally{await c.close();const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}
});
test('local TEST issuer distributes public-only pinned keys and signed bounded fixture JWT',async()=>{
 const temp=mkdtempSync(join(tmpdir(),'a02-issuer-test-'));const child=spawn(process.execPath,[resolve('deploy/test-issuer.mjs')],{cwd:temp,env:{...process.env,MCP_ENVIRONMENT:'TEST',MCP_DATA_CLASS:'FIXTURE',NODE_ENV:'test'},stdio:['ignore','pipe','pipe'],windowsHide:true});let ready=false,logs='';child.stdout.on('data',b=>{logs+=b;ready=true;});child.stderr.on('data',()=>{});
 try{for(let i=0;i<100&&!ready;i++){assert.equal(child.exitCode,null);await new Promise(r=>setTimeout(r,30));}assert.ok(ready);
  const publicFile=join(temp,'.runtime/cloud-test/public-jwks.json');const manifest=JSON.parse(readFileSync(join(temp,'.runtime/cloud-test/public-manifest.json'),'utf8'));
  const tokens=Object.fromEntries(readFileSync(join(temp,'.runtime/cloud-test/identity.env'),'utf8').split('\n').map(s=>s.split('=')));
  const cfg=loadConfig(env({A02_TEST_JWKS_FILE:publicFile,A02_TEST_JWKS_SHA256:manifest.sha256,CAREER_RUNTIME_TOKEN:tokens.USER_A_JWT}));const identity=await createIdentityResolver(cfg)(`Bearer ${caller}`);assert.equal(identity.actor.actor_id,'frontend_fixture_user_a');assert.ok(!logs.includes(tokens.USER_A_JWT));
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(publicFile,'utf8')).keys[0],'d'),false);
 }finally{const closed=new Promise(r=>child.once('close',r));child.kill();await closed;rmSync(temp,{recursive:true,force:true});}
});
