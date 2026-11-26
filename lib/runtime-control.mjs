import { createServer,request } from 'node:http';
import { mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function isProcessAlive(pid){
  try{process.kill(pid,0);return true;}catch(error){return error?.code!=='ESRCH';}
}
export function loopbackHttpRequest({host='127.0.0.1',port,path='/',method='GET',headers={},timeoutMs=5000}={}){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value);};
    const req=request({hostname:host,port,path,method,headers,agent:false},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8'),status=res.statusCode||0;
        finish(resolve,{status,ok:status>=200&&status<300,headers:res.headers,body,json:()=>JSON.parse(body)});
      });
      res.on('error',error=>finish(reject,error));
    });
    const timer=setTimeout(()=>{
      const error=new Error('The operation was aborted due to timeout');
      error.name='TimeoutError';
      error.code='ABORT_ERR';
      req.destroy(error);
      finish(reject,error);
    },timeoutMs);
    timer.unref?.();
    req.on('error',error=>finish(reject,error));
    req.end();
  });
}
export function pruneStaleRuntimeRecords(directory,{currentPid=process.pid,isAlive=isProcessAlive}={}){
  if(!existsSync(directory))return[];
  const removed=[];
  for(const name of readdirSync(directory)){
    const match=name.match(/^(\d+)-[\da-f-]+\.json$/);
    if(!match)continue;
    const pid=Number(match[1]);
    if(!Number.isInteger(pid)||pid<=0||pid===currentPid)continue;
    if(!isAlive(pid)){
      const target=join(directory,name);
      try{unlinkSync(target);removed.push(target);}catch{}
    }
  }
  return removed;
}
export async function serveRuntime({directory,version,stop,health,exit=()=>process.exit(0)}){
  const token=randomBytes(24).toString('hex'),file=join(directory,`${process.pid}-${randomUUID()}.json`);
  const server=createServer(async(request,response)=>{
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(403).end();return;}
    if(request.method==='GET'&&request.url==='/health'){
      try{response.setHeader('content-type','application/json');response.end(JSON.stringify({...await health(),id:'agy-max',version,sidecarReady:true}));}catch{response.writeHead(503).end();}return;
    }
    if(request.method==='POST'&&request.url==='/stop'){
      try{await stop({purge:request.headers['x-agy-purge']==='true'});response.end('{}');}
      catch{response.writeHead(500).end('{}');}
      finally{try{unlinkSync(file);}catch{}server.close();setTimeout(exit,100).unref();}return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  mkdirSync(directory,{recursive:true});
  pruneStaleRuntimeRecords(directory);
  writeFileSync(file,JSON.stringify({id:'agy-max',version,port:server.address().port,token}),{mode:0o600});
  return async()=>{try{unlinkSync(file);}catch{}await new Promise(resolve=>server.close(resolve));};
}

export function runtimeRecords(directory){
  if(!existsSync(directory))return[];
  return readdirSync(directory).flatMap(name=>{
    const pid=Number(name.match(/^(\d+)-[\da-f-]+\.json$/)?.[1]);
    if(!Number.isInteger(pid)||pid<=0||pid>0x7fffffff)return[];
    const file=join(directory,name);
    try{const record=JSON.parse(readFileSync(file,'utf8'));return ['agy-max','agy-powertools'].includes(record.id)&&Number.isInteger(record.port)&&record.port>0&&record.port<65536&&/^[a-f\d]{48}$/.test(record.token)?[{...record,pid,file}]:[];}catch{return[];}
  });
}
export async function stopRuntimes(directory,{purge=false,exitTimeoutMs=8000}={}){
  await Promise.all(runtimeRecords(directory).map(async record=>{
    let acknowledged=false;
    try{
      const response=await loopbackHttpRequest({port:record.port,path:'/stop',method:'POST',headers:{authorization:`Bearer ${record.token}`,'x-agy-purge':String(purge)},timeoutMs:8000});
      if(response.status!==200&&response.status!==403)throw Error('插件暂时无法停止');
      acknowledged=response.status===200;
    }catch(error){
      const code=error?.code||error?.cause?.code;
      if(code!=='ECONNREFUSED')throw Error('插件暂时无法停止，请重新打开客户端后重试');
    }
    if(acknowledged){
      const deadline=Date.now()+Math.min(exitTimeoutMs,1500);
      while(isProcessAlive(record.pid)&&Date.now()<deadline){
        if(!existsSync(record.file)){
          await pause(150);
          break;
        }
        await pause(100);
      }
    }else if(isProcessAlive(record.pid)){
      const deadline=Date.now()+exitTimeoutMs;
      while(isProcessAlive(record.pid)){
        if(Date.now()>=deadline)throw Error('插件进程未退出，请重新打开客户端后重试');
        await pause(100);
      }
    }
    try{unlinkSync(record.file);}catch{}
  }));
}
export async function waitForRuntime(directory,version,{timeout=25000}={}){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    for(const record of runtimeRecords(directory).filter(record=>record.version===version)){
      try{
        const response=await loopbackHttpRequest({port:record.port,path:'/health',headers:{authorization:`Bearer ${record.token}`},timeoutMs:1500});
        if(response.status!==200)continue;
        const status=response.json();
        if(status.id==='agy-max'&&status.version===version&&(status.healthy===true||status.sidecarReady===true))return status;
      }catch{}
    }
    await pause(250);
  }
  throw Error('新版本未能正常启动');
}
