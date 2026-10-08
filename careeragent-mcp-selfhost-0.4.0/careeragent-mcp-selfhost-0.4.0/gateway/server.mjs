import http from 'node:http';
import {timingSafeEqual, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

export function configFromFile(path) {
  const raw=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
  if(raw.environment!=='TEST'||raw.dataClass!=='FIXTURE')throw new Error('Gateway requires TEST/FIXTURE');
  if(!/^[a-f0-9]{64}$/i.test(raw.key||''))throw new Error('Gateway requires independent 256-bit hex key');
  return {key:raw.key,timeoutMs:8000,bodyLimit:262144,responseLimit:2097152};
}
export function allowed(method,path) {
  const id='[A-Za-z0-9_-]{1,128}';
  if(method==='POST')return new RegExp(`^/api/v1/career/runs(?:/${id}/(?:actions|career-decisions))?$`).test(path);
  if(method==='GET')return new RegExp(`^/api/v1/career/runs/${id}$`).test(path)||new RegExp(`^/api/v1/artifacts/${id}\\?view=(?:PROFILE|CAREER_CANDIDATES|SKILL_TREE|PATH)$`).test(path);
  return false;
}
// requestImpl is injectable only for isolated tests. The executable has no configurable target.
export function createGateway(config, requestImpl=http.request, log=record=>console.log(JSON.stringify(record))) {
  let active=0;
  const server=http.createServer(async(req,res)=>{
    const started=Date.now(), requestId=`gateway_${randomUUID()}`;let upstream;
    res.on('finish',()=>log({request_id:requestId,method:req.method,status:res.statusCode,duration_ms:Date.now()-started}));
    const fail=(status,code)=>{if(!res.writableEnded){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({success:false,error:{code,message:code,retryable:status===502||status===504},request_id:requestId}));}};
    const counts={};for(let i=0;i<req.rawHeaders.length;i+=2){const n=req.rawHeaders[i].toLowerCase();counts[n]=(counts[n]||0)+1;}
    if(['x-a02-tunnel-key','authorization','content-length','host'].some(h=>counts[h]>1)){fail(400,'GATEWAY_DUPLICATE_HEADER');return;}
    const supplied=Buffer.from(req.headers['x-a02-tunnel-key']||''),expected=Buffer.from(config.key);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){fail(403,'GATEWAY_ACCESS_DENIED');return;}
    if(!allowed(req.method,req.url)){fail(404,'GATEWAY_ROUTE_DENIED');return;}
    if(active>=16){fail(429,'GATEWAY_BUSY');return;}
    if(req.headers['content-encoding']||Number(req.headers['content-length']||0)>config.bodyLimit){fail(413,'GATEWAY_BODY_LIMIT');return;}
    if(req.method==='POST'&&!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){fail(415,'GATEWAY_JSON_REQUIRED');return;}
    active++;
    const timer=setTimeout(()=>{fail(504,'GATEWAY_TIMEOUT');upstream?.destroy();req.resume();},config.timeoutMs);
    const cleanup=()=>{clearTimeout(timer);active--;upstream?.destroy();};res.once('close',cleanup);
    try {
      const chunks=[];let length=0;
      for await(const chunk of req){length+=chunk.length;if(length>config.bodyLimit){fail(413,'GATEWAY_BODY_LIMIT');req.resume();return;}chunks.push(chunk);}
      if(res.writableEnded)return;
      if(req.method==='GET'&&length){fail(400,'GATEWAY_GET_BODY_DENIED');return;}
      const headers={'content-type':'application/json','content-length':length};
      if(req.headers.authorization)headers.authorization=req.headers.authorization;
      if(/^[A-Za-z0-9_.:-]{1,128}$/.test(req.headers['x-request-id']||''))headers['x-request-id']=req.headers['x-request-id'];
      upstream=requestImpl({hostname:'127.0.0.1',port:8080,path:req.url,method:req.method,headers},response=>{
        if(response.statusCode>=300&&response.statusCode<400){response.resume();fail(502,'GATEWAY_REDIRECT_DENIED');return;}
        if(!/^application\/json(?:;|$)/i.test(response.headers['content-type']||'')){response.resume();fail(502,'GATEWAY_INVALID_RESPONSE');return;}
        const parts=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>config.responseLimit){fail(502,'GATEWAY_RESPONSE_LIMIT');response.destroy();}else parts.push(chunk);});
        response.on('error',()=>fail(502,'GATEWAY_UPSTREAM_ERROR'));
        response.on('end',()=>{if(res.writableEnded)return;const output={'content-type':response.headers['content-type'],'cache-control':'no-store'};if(response.headers['x-request-id'])output['x-request-id']=response.headers['x-request-id'];res.writeHead(response.statusCode,output);res.end(Buffer.concat(parts));});
      });
      upstream.on('error',()=>fail(502,'GATEWAY_UPSTREAM_ERROR'));upstream.end(Buffer.concat(chunks));
    }catch {fail(400,'GATEWAY_INVALID_REQUEST');}
  });
  server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=1000;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const config=configFromFile(process.env.A02_GATEWAY_CONFIG||'.runtime/tunnel-gateway.json');const server=createGateway(config);server.listen(18080,'127.0.0.1',()=>console.log('A02 TEST/FIXTURE gateway listening on 127.0.0.1:18080'));for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});}
  catch{console.error('Gateway startup rejected: check local TEST/FIXTURE configuration');process.exitCode=1;}
}
