// Explicit operator bootstrap only. Private key stays in this process on Windows.
import http from 'node:http';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
if(process.env.MCP_ENVIRONMENT!=='TEST'||process.env.MCP_DATA_CLASS!=='FIXTURE'||process.env.NODE_ENV==='production')throw new Error('Explicit TEST/FIXTURE required');
const output=resolve('.runtime/cloud-test');mkdirSync(output,{recursive:true});
const {privateKey,publicKey}=await generateKeyPair('RS256',{modulusLength:2048});
const kid=`test_${randomUUID()}`;
const document=JSON.stringify({keys:[{...await exportJWK(publicKey),kid,alg:'RS256',use:'sig'}]});
const digest=createHash('sha256').update(document).digest('hex');
const expiry=Math.floor(Date.now()/1000)+1800;
const tokens={};
for(const suffix of ['a','b'])tokens[`USER_${suffix.toUpperCase()}_JWT`]=await new SignJWT({actor_role:'PERSONAL_USER',environment:'TEST',data_class:'FIXTURE'})
 .setProtectedHeader({alg:'RS256',kid}).setIssuer('urn:a02:careeragent:test').setAudience('urn:a02:careeragent:backend:test')
 .setSubject(`frontend_fixture_user_${suffix}`).setIssuedAt().setExpirationTime(expiry).sign(privateKey);
const server=http.createServer((req,res)=>{if(req.method!=='GET'||req.url!=='/.well-known/jwks.json'){res.writeHead(404);res.end();return;}res.writeHead(200,{'content-type':'application/json'});res.end(document);});
server.on('error',()=>{console.error('TEST issuer listen failed');process.exitCode=1;});
server.listen(19091,'127.0.0.1',()=>{
 writeFileSync(resolve(output,'public-jwks.json'),document,{mode:0o600});
 writeFileSync(resolve(output,'identity.env'),Object.entries(tokens).map(([k,v])=>`${k}=${v}`).join('\n'),{mode:0o600});
 writeFileSync(resolve(output,'public-manifest.json'),JSON.stringify({sha256:digest,kid,issuer:'urn:a02:careeragent:test',audience:'urn:a02:careeragent:backend:test',expires_at:new Date(expiry*1000).toISOString()},null,2));
 console.log(JSON.stringify({service:'TEST/FIXTURE issuer',listen:'127.0.0.1:19091',public_key_sha256:digest,expires_at:new Date(expiry*1000).toISOString()}));
});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
