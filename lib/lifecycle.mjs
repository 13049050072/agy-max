import { existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,rmSync,readdirSync,lstatSync,unlinkSync,openSync,closeSync,cpSync,rmdirSync } from 'node:fs';
import { join,resolve,relative,dirname,isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { collectPackage,validatePackage,writePackage,sha256 } from './package.mjs';
import { stopRuntimes } from './runtime-control.mjs';
import { configureLaunchers,restoreLaunchers } from './launcher.mjs';
import { syncBundledAgyFast,cleanupBundledAgyFast } from './agy-fast-bundle.mjs';

export function installationPaths(home=homedir()){
  const root=join(resolve(home),'.gemini');
  return {home:resolve(home),root,config:join(root,'config','config.json'),installed:join(root,'config','plugins','agy-max'),data:join(root,'antigravity','plugin_data','agy-max'),sidecars:join(root,'antigravity','sidecar_data','agy-max'),brain:join(root,'antigravity','brain')};
}
export function assertOwnedPath(root,target){
  const rel=relative(resolve(root),resolve(target));if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('目标路径越界');
  let path=resolve(root);if(lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('目标目录不能是符号链接');
  for(const part of rel.split(/[\\/]/)){path=join(path,part);if(lstatSync(path,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('目标路径包含符号链接');}
  return resolve(target);
}
function assertTree(path){const stat=lstatSync(path,{throwIfNoEntry:false});if(!stat)return;if(stat.isSymbolicLink())throw Error('清理目录中包含符号链接');if(stat.isDirectory())for(const name of readdirSync(path))assertTree(join(path,name));}
function removeTree(root,path){assertOwnedPath(root,path);assertTree(path);rmSync(path,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
function isSameOrAncestor(parent,child){const rel=relative(resolve(parent),resolve(child));return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));}
function removeTreePreserving(root,target,preserve){
  const resolvedTarget=resolve(target),relevant=preserve.filter(p=>isSameOrAncestor(resolvedTarget,p));
  if(!relevant.length){removeTree(root,target);return;}
  if(relevant.some(p=>relative(resolvedTarget,resolve(p))===''))return;
  assertOwnedPath(root,target);
  const stat=lstatSync(target,{throwIfNoEntry:false});if(!stat)return;
  if(stat.isSymbolicLink())throw Error('清理目录中包含符号链接');
  if(!stat.isDirectory())return;
  for(const name of readdirSync(target))removeTreePreserving(root,join(target,name),relevant);
}
async function move(from,to){for(let i=0;;i++){try{renameSync(from,to);return;}catch(error){if(i>=20||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await new Promise(resolve=>setTimeout(resolve,100));}}}
function synchronize(from,to){
  assertTree(from);assertTree(to);
  function prepare(source,target){
    const directory=lstatSync(source).isDirectory();
    if(existsSync(target)&&lstatSync(target).isDirectory()!==directory)removeTree(to,target);
    if(directory){mkdirSync(target,{recursive:true});for(const name of readdirSync(source))prepare(join(source,name),join(target,name));}
  }
  prepare(from,to);cpSync(from,to,{recursive:true,force:true});
  function prune(source,target){for(const name of readdirSync(target)){
    const path=join(target,name),original=join(source,name);
    if(existsSync(original)){if(lstatSync(path).isDirectory())prune(original,path);continue;}
    if(lstatSync(path).isDirectory()){prune(original,path);try{rmdirSync(path);}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;}}
    else unlinkSync(path);
  }}prune(from,to);
}
export function atomicJson(path,value){
  mkdirSync(dirname(path),{recursive:true});const temp=join(dirname(path),'.agy-'+randomUUID()+'.tmp');
  try{writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,path);}finally{try{unlinkSync(temp);}catch{}}
}
function readConfig(path){if(!existsSync(path))return{};const value=JSON.parse(readFileSync(path,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('客户端配置格式无效');return value;}
function changeConfig(paths,fn){assertOwnedPath(paths.root,paths.config);const config=readConfig(paths.config);fn(config);atomicJson(paths.config,config);}
const CORRUPT_LOCK_GRACE_MS=2000;
function isProcessAlive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error?.code!=='ESRCH';}
}
export function acquireLockFile(path,{busyMessage='已有操作正在进行',corruptGraceMs=CORRUPT_LOCK_GRACE_MS,now=Date.now,isAlive=isProcessAlive}={}){
  const nonce=randomUUID();let handle;
  for(let attempt=0;attempt<2;attempt++){
    try{handle=openSync(path,'wx');break;}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(attempt>0)throw Error(busyMessage);
      let raw,mtimeMs=0;
      try{mtimeMs=lstatSync(path).mtimeMs;raw=readFileSync(path,'utf8');}catch(readError){
        if(readError?.code==='ENOENT')continue;
        throw readError;
      }
      let lock=null,corrupt=false;
      try{lock=JSON.parse(raw);}catch{corrupt=true;}
      if(corrupt){
        if(now()-mtimeMs<corruptGraceMs)throw Error(busyMessage);
      }else{
        const pid=lock&&typeof lock==='object'?lock.pid:null;
        if(Number.isInteger(pid)&&pid>0&&isAlive(pid))throw Error(busyMessage);
      }
      try{unlinkSync(path);}catch(unlinkError){if(unlinkError?.code!=='ENOENT')throw unlinkError;}
    }
  }
  try{writeFileSync(handle,JSON.stringify({pid:process.pid,nonce}));closeSync(handle);}
  catch(error){try{closeSync(handle);}catch{}try{unlinkSync(path);}catch{}throw error;}
  return nonce;
}
export function releaseLockFile(path,nonce){
  if(!nonce)return;
  try{if(JSON.parse(readFileSync(path,'utf8')).nonce===nonce)unlinkSync(path);}catch{}
}
async function withLock(paths,fn){
  assertOwnedPath(paths.home,paths.data);mkdirSync(paths.data,{recursive:true});
  const path=join(paths.data,'maintenance.lock');
  const nonce=acquireLockFile(path,{busyMessage:'已有安装或更新正在进行'});
  try{return await fn();}finally{releaseLockFile(path,nonce);}
}
function previousPlugin(paths){const config=readConfig(paths.config);return config.plugins?.['agy-max'];}
function setPlugin(paths,value){changeConfig(paths,config=>{config.plugins||={};if(value===undefined)delete config.plugins['agy-max'];else config.plugins['agy-max']=value;});}
function legacyBackups(source){
  const directory=join(source,'.backups');if(!existsSync(directory))return[];
  return readdirSync(directory).filter(name=>/^installed-\d{4}-[\dTZ.-]+$/.test(name)).flatMap(name=>{
    const path=join(directory,name);try{assertOwnedPath(source,path);const file=join(path,'plugin.json'),bytes=readFileSync(file);return JSON.parse(bytes).name==='agy-max'?[{name,pluginHash:sha256(bytes)}]:[];}catch{return[];}
  });
}
async function migrateLegacyPowertools(paths,stop){
  const cur=readConfig(paths.config);let tookOver=false;
  if(cur.plugins?.['agy-powertools']?.enabled){changeConfig(paths,c=>{if(c.plugins?.['agy-powertools'])c.plugins['agy-powertools']={...c.plugins['agy-powertools'],enabled:false};});tookOver=true;}
  const legacyData=join(paths.root,'antigravity','plugin_data','agy-powertools');
  const legacyStat=lstatSync(legacyData,{throwIfNoEntry:false});
  if(legacyStat&&!legacyStat.isSymbolicLink()&&existsSync(join(legacyData,'runtime')))await stop(join(legacyData,'runtime')).catch(()=>{});
  if(!legacyStat||legacyStat.isSymbolicLink())return tookOver;
  for(const file of ['settings.json','goals.json','accounts.json']){
    const src=join(legacyData,file),dst=join(paths.data,file);
    const srcStat=lstatSync(src,{throwIfNoEntry:false}),dstStat=lstatSync(dst,{throwIfNoEntry:false});
    if(srcStat&&!srcStat.isSymbolicLink()&&!dstStat){mkdirSync(paths.data,{recursive:true});writeFileSync(dst,readFileSync(src),{mode:file==='accounts.json'?0o600:0o644});tookOver=true;}
  }
  return tookOver;
}

export async function installPlugin({source,bundle,home=homedir(),stop=stopRuntimes,verify,retainBackup=true}={}){
  const paths=installationPaths(home),payload=bundle?validatePackage(bundle):collectPackage(resolve(source));
  assertOwnedPath(paths.home,paths.installed);assertOwnedPath(paths.home,paths.data);
  return withLock(paths,async()=>{
    const previous=previousPlugin(paths),id=randomUUID(),stage=join(paths.data,'staging',id),backup=join(paths.data,'backups',id,'plugin');
    let moved=false,promoted=false,inPlace=false,receipt;
    try{
      if(existsSync(paths.installed)&&JSON.parse(readFileSync(join(paths.installed,'plugin.json'),'utf8')).name!=='agy-max')throw Error('安装位置包含其他项目');
      const migratedLegacy=await migrateLegacyPowertools(paths,stop);
      assertOwnedPath(paths.root,stage);receipt=writePackage(payload,stage);
      const previousReceipt=existsSync(join(paths.installed,'.agy-install.json'))?JSON.parse(readFileSync(join(paths.installed,'.agy-install.json'),'utf8')):{};
      receipt.sourceRoot=source?resolve(source):previousReceipt.sourceRoot;
      receipt.legacyBackups=source?legacyBackups(resolve(source)):previousReceipt.legacyBackups||[];
      atomicJson(join(stage,'.agy-install.json'),receipt);
      setPlugin(paths,{...previous,enabled:false});await stop(join(paths.data,'runtime'));
      if(existsSync(paths.installed)){
        assertTree(paths.installed);mkdirSync(dirname(backup),{recursive:true});
        try{await move(paths.installed,backup);}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;cpSync(paths.installed,backup,{recursive:true});inPlace=true;}moved=true;
      }
      mkdirSync(dirname(paths.installed),{recursive:true});
      if(inPlace)synchronize(stage,paths.installed);else await move(stage,paths.installed);promoted=true;
      for(const file of receipt.files)if(sha256(readFileSync(join(paths.installed,file.path)))!==file.sha256)throw Error('安装后校验失败');
      setPlugin(paths,{...previous,enabled:true});
      if(verify)await verify({paths,version:payload.version});
      try{
        const savedCfg=existsSync(join(paths.data,'settings.json'))?JSON.parse(readFileSync(join(paths.data,'settings.json'),'utf8')):{};
        const wantAgyFast=savedCfg?.enabled!==false&&savedCfg?.agyFast!==false;
        syncBundledAgyFast({home:paths.home,enabled:wantAgyFast,vendorDir:join(paths.installed,'lib','vendor','agy-fast')});
      }catch{}
      let launcherResult=null;
      try{launcherResult=configureLaunchers({home:paths.home,dataDir:paths.data});}catch{}
      if(!retainBackup&&moved)removeTree(paths.data,dirname(backup));
      return{version:payload.version,destination:paths.installed,backup:moved&&retainBackup?backup:null,migratedLegacy,restartRequired:!verify,replacement:inPlace?'in-place':'directory',...(process.platform==='darwin'?{macLauncherApp:launcherResult?.macApp||null,macLauncherIconConfigured:Boolean(launcherResult?.iconConfigured)}:{})};
    }catch(error){
      setPlugin(paths,{...previous,enabled:false});await stop(join(paths.data,'runtime')).catch(()=>{});
      if(inPlace&&moved)synchronize(backup,paths.installed);
      else{if(promoted)removeTree(paths.root,paths.installed);if(moved){mkdirSync(dirname(paths.installed),{recursive:true});await move(backup,paths.installed);}}
      setPlugin(paths,previous);error.rolledBack=true;throw error;
    }finally{if(existsSync(stage))removeTree(paths.root,stage);}
  });
}

function ownTelemetry(path){
  try{return readFileSync(path,'utf8').split('\n').filter(Boolean).every(line=>{
    const value=JSON.parse(line);return value.pluginId==='agy-max'||['PreInvocation','PostInvocation'].includes(value.event)&&Number.isFinite(value.ts)&&typeof value.iso==='string'&&'invocationNum'in value&&'initialNumSteps'in value&&Object.keys(value).every(key=>['event','ts','iso','conversationId','invocationNum','initialNumSteps','modelName'].includes(key));
  });}catch{return false;}
}
function cleanBrain(paths){
  const retained=[];if(!existsSync(paths.brain))return retained;
  for(const id of readdirSync(paths.brain)){
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))continue;
    for(const name of ['telemetry.jsonl','max-telemetry.jsonl']){
      const path=join(paths.brain,id,'.system_generated','logs',name);try{assertOwnedPath(paths.root,path);}catch{retained.push(path);continue;}
      if(existsSync(path)){if(ownTelemetry(path))unlinkSync(path);else retained.push(path);}
    }
  }
  return retained;
}

export async function uninstallPlugin({home=homedir(),purge=true,stop=stopRuntimes}={}){
  const paths=installationPaths(home);assertOwnedPath(paths.home,paths.installed);assertOwnedPath(paths.home,paths.data);
  const result=await withLock(paths,async()=>{
    if(existsSync(paths.installed)&&JSON.parse(readFileSync(join(paths.installed,'plugin.json'),'utf8')).name!=='agy-max')throw Error('安装位置包含其他项目');
    const receipt=existsSync(join(paths.installed,'.agy-install.json'))?JSON.parse(readFileSync(join(paths.installed,'.agy-install.json'),'utf8')):{};
    setPlugin(paths,{...previousPlugin(paths),enabled:false});await stop(join(paths.data,'runtime'),{purge});
    removeTree(paths.root,paths.installed);
    changeConfig(paths,config=>{delete config.plugins?.['agy-max'];for(const key of Object.keys(config.sidecars||{}))if(key==='agy-max'||key.startsWith('agy-max/'))delete config.sidecars[key];});
    const hooks=join(paths.root,'config','hooks.json');assertOwnedPath(paths.root,hooks);
    if(existsSync(hooks)){const config=readConfig(hooks);for(const key of Object.keys(config))if(key==='agy-max-telemetry'||key.startsWith('agy-max/'))delete config[key];atomicJson(hooks,config);}
    const agyFastCleanup=cleanupBundledAgyFast({home:paths.home});
    const retained=[...(agyFastCleanup?.retained||[]),...(purge?cleanBrain(paths):[])];
    if(purge){
      removeTree(paths.root,paths.sidecars);
      if(receipt.sourceRoot)for(const backup of receipt.legacyBackups||[]){
        const path=join(receipt.sourceRoot,'.backups',backup.name);if(!/^installed-\d{4}-[\dTZ.-]+$/.test(backup.name))continue;
        try{assertOwnedPath(join(receipt.sourceRoot,'.backups'),path);if(sha256(readFileSync(join(path,'plugin.json')))===backup.pluginHash)removeTree(join(receipt.sourceRoot,'.backups'),path);}catch{if(existsSync(path))retained.push(path);}
      }
    }
    return{removed:true,purged:purge,retained};
  });
  try{restoreLaunchers({home:paths.home,dataDir:paths.data});}catch{}
  if(purge)removeTreePreserving(paths.root,paths.data,result.retained);
  return result;
}
