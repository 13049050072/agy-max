import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync,symlinkSync,utimesSync} from 'node:fs';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {collectPackage,writePackage,encodePackage,decodePackage,validatePackage,sha256,releaseName} from '../lib/package.mjs';
import {installationPaths,installPlugin,uninstallPlugin,atomicJson,assertOwnedPath,acquireLockFile,releaseLockFile} from '../lib/lifecycle.mjs';
import {runUpdateJob,updateStatus,startUpdate,mergeLoopbackNoProxy} from '../lib/update-manager.mjs';
import {serveRuntime,stopRuntimes,waitForRuntime,runtimeRecords} from '../lib/runtime-control.mjs';

const original=collectPackage(resolve('.')),stop=async()=>{};
function variant(version){const copy=structuredClone(original);copy.version=version;for(const file of copy.files){
  let text=Buffer.from(file.data,'base64').toString('utf8');
  if(['package.json','plugin.json','package-lock.json'].includes(file.path)){const value=JSON.parse(text);value.version=version;if(value.packages?.[''])value.packages[''].version=version;text=JSON.stringify(value);}
  if(file.path==='sidecars/inspector/sidecar.json'){const value=JSON.parse(text);value.env.AGY_MAX_VERSION=version;text=JSON.stringify(value);}
  if(['lib/native-client.js','lib/native-ui.js'].includes(file.path))text=text.replaceAll(original.version,version);
  const bytes=Buffer.from(text);file.data=bytes.toString('base64');file.sha256=sha256(bytes);
}return validatePackage(copy);}
const older=variant('0.9.0'),newer=variant('1.2.0');
function sandbox(){const root=mkdtempSync(join(tmpdir(),'agy-lifecycle-')),home=join(root,'home'),paths=installationPaths(home);mkdirSync(join(paths.root,'config'),{recursive:true});atomicJson(paths.config,{plugins:{other:{enabled:true}},userSettings:{language:'zh-CN'},sidecars:{'other/tool':{keep:true}}});return{root,home,paths,clean:()=>rmSync(root,{recursive:true,force:true})};}

test('install replaces obsolete files, preserves settings and other plugins, and records a usable backup',async()=>{
  const s=sandbox();try{
    await installPlugin({bundle:older,home:s.home,stop});mkdirSync(s.paths.data,{recursive:true});const settings='{"language":"zh-CN","contextLimit":1000000}';writeFileSync(join(s.paths.data,'settings.json'),settings);writeFileSync(join(s.paths.installed,'obsolete.txt'),'old');
    const result=await installPlugin({bundle:original,home:s.home,stop});assert.equal(result.version,original.version);assert.ok(existsSync(join(result.backup,'obsolete.txt')));assert.equal(existsSync(join(s.paths.installed,'obsolete.txt')),false);assert.equal(readFileSync(join(s.paths.data,'settings.json'),'utf8'),settings);
    const config=JSON.parse(readFileSync(s.paths.config));assert.deepEqual(config.plugins.other,{enabled:true});assert.equal(config.userSettings.language,'zh-CN');assert.equal(config.plugins['agy-max'].enabled,true);
    assert.ok(!readdirSync(join(s.paths.root,'config','plugins')).some(name=>name.startsWith('.agy-max-stage')));
  }finally{s.clean();}
});

test('startup failure restores old plugin and original registration without changing chat data',async()=>{
  const s=sandbox();try{
    await installPlugin({bundle:older,home:s.home,stop});mkdirSync(join(s.paths.brain,'chat'),{recursive:true});writeFileSync(join(s.paths.brain,'chat','history.db'),'original chat');
    const before=readFileSync(join(s.paths.installed,'plugin.json'));await assert.rejects(()=>installPlugin({bundle:newer,home:s.home,stop,verify:async()=>{throw Error('startup failed');}}),error=>error.rolledBack===true);
    assert.deepEqual(readFileSync(join(s.paths.installed,'plugin.json')),before);assert.equal(JSON.parse(readFileSync(s.paths.config)).plugins['agy-max'].enabled,true);assert.equal(readFileSync(join(s.paths.brain,'chat','history.db'),'utf8'),'original chat');
  }finally{s.clean();}
});

test('purge removes owned files, runtime data and registration while preserving native chats and unrelated logs',async()=>{
  const s=sandbox();try{
    await installPlugin({bundle:original,home:s.home,stop});mkdirSync(s.paths.sidecars,{recursive:true});writeFileSync(join(s.paths.sidecars,'sidecar.log'),'plugin');
    const logs=join(s.paths.brain,'chat','.system_generated','logs');mkdirSync(logs,{recursive:true});writeFileSync(join(logs,'transcript.jsonl'),'native transcript');writeFileSync(join(logs,'max-telemetry.jsonl'),JSON.stringify({pluginId:'agy-max'}));writeFileSync(join(logs,'telemetry.jsonl'),JSON.stringify({belongs:'another plugin'}));
    atomicJson(s.paths.config,{plugins:{other:{enabled:true},'agy-max':{enabled:true}},sidecars:{'agy-max/inspector':{},'other/tool':{keep:true}},userSettings:{keep:true}});
    const result=await uninstallPlugin({home:s.home,stop});assert.equal(result.retained.length,1);assert.equal(existsSync(s.paths.installed),false);assert.equal(existsSync(s.paths.data),false);assert.equal(existsSync(s.paths.sidecars),false);assert.equal(existsSync(join(logs,'max-telemetry.jsonl')),false);assert.equal(readFileSync(join(logs,'transcript.jsonl'),'utf8'),'native transcript');assert.equal(existsSync(join(logs,'telemetry.jsonl')),true);
    const config=JSON.parse(readFileSync(s.paths.config));assert.equal(config.plugins['agy-max'],undefined);assert.deepEqual(config.plugins.other,{enabled:true});assert.equal(config.sidecars['agy-max/inspector'],undefined);assert.deepEqual(config.sidecars['other/tool'],{keep:true});assert.deepEqual(config.userSettings,{keep:true});
    await uninstallPlugin({home:s.home,stop});assert.equal(existsSync(s.paths.data),false);
  }finally{s.clean();}
});

test('keep-settings uninstall retains preferences and removes the installed plugin',async()=>{
  const s=sandbox();try{await installPlugin({bundle:original,home:s.home,stop});writeFileSync(join(s.paths.data,'settings.json'),'{}');await uninstallPlugin({home:s.home,purge:false,stop});assert.equal(existsSync(s.paths.installed),false);assert.equal(readFileSync(join(s.paths.data,'settings.json'),'utf8'),'{}');}finally{s.clean();}
});

test('legacy installer backups are purged only when registered and identified as this plugin',async()=>{
  const s=sandbox();try{
    const source=join(s.root,'source');writePackage(original,source);const owned=join(source,'.backups','installed-2026-11-15T00-00-00-000Z'),foreign=join(source,'.backups','installed-2026-11-14T00-00-00-000Z');mkdirSync(owned,{recursive:true});mkdirSync(foreign,{recursive:true});atomicJson(join(owned,'plugin.json'),{name:'agy-max'});atomicJson(join(foreign,'plugin.json'),{name:'other'});
    await installPlugin({source,home:s.home,stop});await uninstallPlugin({home:s.home,stop});assert.equal(existsSync(owned),false);assert.equal(existsSync(foreign),true);assert.equal(existsSync(join(source,'package.json')),true);
  }finally{s.clean();}
});

test('invalid package paths, checksums, versions and symlink destinations cannot overwrite other files',async()=>{
  const s=sandbox();try{
    for(const path of ['../outside','lib/../../outside','lib/CON','lib/x.','lib/C:\\outside']){const broken=structuredClone(original);broken.files[0].path=path;assert.throws(()=>validatePackage(broken));}
    const broken=structuredClone(original);broken.files[0].sha256='0'.repeat(64);assert.throws(()=>validatePackage(broken),/校验/);assert.throws(()=>decodePackage(encodePackage(original),'9.9.9'),/信息/);
    const external=join(s.root,'external');mkdirSync(external);mkdirSync(join(s.paths.root,'config','plugins'),{recursive:true});symlinkSync(external,s.paths.installed,process.platform==='win32'?'junction':'dir');
    await assert.rejects(()=>installPlugin({bundle:original,home:s.home,stop}),/符号链接/);assert.deepEqual(readdirSync(external),[]);
  }finally{s.clean();}
});

test('corrupt configuration is not overwritten during installation',async()=>{
  const s=sandbox();try{writeFileSync(s.paths.config,'{incomplete');await assert.rejects(()=>installPlugin({bundle:original,home:s.home,stop}));assert.equal(readFileSync(s.paths.config,'utf8'),'{incomplete');}finally{s.clean();}
});

test('verified update installs in a sandbox; bad downloads leave the existing version untouched',async()=>{
  const s=sandbox();try{
    await installPlugin({bundle:older,home:s.home,stop});const bytes=encodePackage(newer),job=join(s.paths.data,'jobs','test');mkdirSync(job,{recursive:true});
    const plan={format:1,home:s.home,version:newer.version,job,asset:{name:releaseName(newer.version),url:'https://github.com/test/project/releases/download/v1.2.0/package.bundle.gz',sha256:sha256(bytes)}};
    await runUpdateJob(plan,{fetcher:async()=>new Response(bytes),verify:async({paths,version})=>assert.equal(JSON.parse(readFileSync(join(paths.installed,'plugin.json'))).version,version)});
    assert.equal(updateStatus(s.home).status,'completed');assert.equal(existsSync(job),false);
    mkdirSync(job,{recursive:true});await assert.rejects(()=>runUpdateJob({...plan,asset:{...plan.asset,sha256:'0'.repeat(64)}},{fetcher:async()=>new Response(bytes),verify:async()=>{throw Error('should not install');}}),/校验/);assert.equal(JSON.parse(readFileSync(join(s.paths.installed,'plugin.json'))).version,newer.version);
  }finally{s.clean();}
});

test('update startup failure rolls back and reports rollback instead of success',async()=>{
  const s=sandbox();try{
    await installPlugin({bundle:older,home:s.home,stop});const bytes=encodePackage(newer),job=join(s.paths.data,'jobs','failure');mkdirSync(job,{recursive:true});
    await assert.rejects(()=>runUpdateJob({format:1,home:s.home,version:newer.version,job,asset:{name:releaseName(newer.version),url:'https://github.com/test/project/releases/download/v1.2.0/package.bundle.gz',sha256:sha256(bytes)}},{fetcher:async()=>new Response(bytes),verify:async()=>{throw Error('cannot start');}}));
    assert.equal(updateStatus(s.home).status,'rolled-back');assert.equal(JSON.parse(readFileSync(join(s.paths.installed,'plugin.json'))).version,older.version);
  }finally{s.clean();}
});

test('update preparation refuses unconfigured repositories and stale user-selected versions',async()=>{
  const s=sandbox();try{
    await assert.rejects(()=>startUpdate({home:s.home,currentVersion:original.version,expectedVersion:'1.2.0',project:{githubUrl:''}}),/版本/);
    assert.equal(existsSync(join(s.paths.data,'jobs')),false);
  }finally{s.clean();}
});

test('update handoff copies a self-contained helper and rejects concurrent jobs',async()=>{
  const s=sandbox();try{
    await installPlugin({bundle:older,home:s.home,stop});const bytes=encodePackage(newer),name=releaseName(newer.version);let captured;
    const fetcher=async()=>new Response(JSON.stringify({tag_name:'v'+newer.version,assets:[{name,state:'uploaded',digest:'sha256:'+sha256(bytes)}]}));
    const result=await startUpdate({home:s.home,currentVersion:older.version,expectedVersion:newer.version,project:{githubUrl:'https://github.com/test/project'},fetcher,launch:async(script,path)=>{captured={script,path};return process.pid;}});
    assert.equal(result.status,'preparing');assert.ok(existsSync(captured.script));assert.ok(captured.script.startsWith(join(s.paths.data,'jobs')));assert.ok(!captured.script.startsWith(s.paths.installed));
    await assert.rejects(()=>startUpdate({home:s.home,currentVersion:older.version,expectedVersion:newer.version,project:{githubUrl:'https://github.com/test/project'},fetcher}),/更新正在进行/);
    const plan=JSON.parse(readFileSync(captured.path));await runUpdateJob(plan,{fetcher:async()=>new Response(bytes),verify:async()=>{}});assert.equal(existsSync(join(s.paths.data,'update.lock')),false);
  }finally{s.clean();}
});

test('checksum-file fallback verifies the exact release asset and cleans partial jobs on error',async()=>{
  const s=sandbox();try{
    await installPlugin({bundle:older,home:s.home,stop});const bytes=encodePackage(newer),name=releaseName(newer.version),job=join(s.paths.data,'jobs','checksum');mkdirSync(job,{recursive:true});
    const plan={format:1,home:s.home,version:newer.version,job,asset:{name,url:'https://github.com/test/project/releases/download/v1.2.0/package.bundle.gz',checksumUrl:'https://github.com/test/project/releases/download/v1.2.0/package.bundle.gz.sha256'}};
    await runUpdateJob(plan,{fetcher:async url=>new Response(url.endsWith('.sha256')?sha256(bytes)+'  '+name+'\n':bytes),verify:async()=>{}});assert.equal(updateStatus(s.home).status,'completed');
    mkdirSync(job,{recursive:true});await assert.rejects(()=>runUpdateJob(plan,{fetcher:async()=>new Response(sha256(bytes)+'  another-file\n'),verify:async()=>{}}),/校验/);assert.equal(existsSync(job),false);
  }finally{s.clean();}
});

test('runtime shutdown uses a private local endpoint and never kills a process by stored pid',async()=>{
  const s=sandbox();let close,stopped=false,exited=false;try{
    const directory=join(s.paths.data,'runtime');close=await serveRuntime({directory,version:original.version,stop:async()=>{stopped=true;},health:async()=>({healthy:true}),exit:()=>{exited=true;}});
    const record=runtimeRecords(directory)[0];assert.equal((await fetch(`http://127.0.0.1:${record.port}/health`)).status,403);
    assert.equal((await waitForRuntime(directory,original.version,{timeout:1000})).healthy,true);
    await stopRuntimes(directory,{purge:true});assert.equal(stopped,true);assert.equal(exited,true);assert.equal(runtimeRecords(directory).length,0);
  }finally{await close?.();s.clean();}
});

test('Windows occupied working directories use verified file replacement and retain rollback support',{skip:process.platform!=='win32'},async()=>{
  const s=sandbox();let child;
  try{
    await installPlugin({bundle:older,home:s.home,stop});mkdirSync(join(s.paths.installed,'lib','type-change'));writeFileSync(join(s.paths.installed,'lib','type-change','old'),'old');
    child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:join(s.paths.installed,'sidecars','inspector'),windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    const changed=structuredClone(original),data=Buffer.from('new file');changed.files.push({path:'lib/type-change',data:data.toString('base64'),sha256:sha256(data)});
    const result=await installPlugin({bundle:changed,home:s.home,stop});assert.equal(result.replacement,'in-place');assert.equal(readFileSync(join(s.paths.installed,'lib','type-change'),'utf8'),'new file');
    await assert.rejects(()=>installPlugin({bundle:newer,home:s.home,stop,verify:async()=>{throw Error('bad startup');}}),error=>error.rolledBack===true);
    assert.equal(JSON.parse(readFileSync(join(s.paths.installed,'plugin.json'))).version,original.version);
  }finally{if(child?.pid){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}s.clean();}
});

test('a separate update helper survives replacing its installed origin and confirms a restarted runtime',async()=>{
  const s=sandbox();let oldClose,newClose,timer,childPromise;
  try{
    await installPlugin({bundle:older,home:s.home,stop});const directory=join(s.paths.data,'runtime');
    oldClose=await serveRuntime({directory,version:older.version,stop:async()=>{},health:async()=>({healthy:true}),exit:()=>{}});
    const bytes=encodePackage(newer),fetchModule=join(s.root,'fake-github.mjs');
    writeFileSync(fetchModule,`const original=globalThis.fetch;globalThis.fetch=async(url,options)=>String(url).startsWith('https://github.com/test/project/releases/download/')?new Response(Buffer.from('${bytes.toString('base64')}','base64')):original(url,options);`);
    let starting=false;
    timer=setInterval(async()=>{try{if(!newClose&&!starting&&JSON.parse(readFileSync(join(s.paths.installed,'plugin.json'))).version===newer.version&&JSON.parse(readFileSync(s.paths.config)).plugins['agy-max'].enabled){starting=true;newClose=await serveRuntime({directory,version:newer.version,stop:async()=>{},health:async()=>({healthy:true}),exit:()=>{}});}}catch{}},25);
    const name=releaseName(newer.version);
    await startUpdate({home:s.home,currentVersion:older.version,expectedVersion:newer.version,project:{githubUrl:'https://github.com/test/project'},fetcher:async()=>new Response(JSON.stringify({tag_name:'v'+newer.version,assets:[{name,state:'uploaded',digest:'sha256:'+sha256(bytes)}]})),launch:async(script,plan)=>{
      const child=spawn(process.execPath,['--import',pathToFileURL(fetchModule).href,script,plan],{cwd:s.root,windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',chunk=>{error+=chunk;});childPromise=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error(error||'worker failed')));});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});return child.pid;
    }});
    await childPromise;assert.equal(updateStatus(s.home).status,'completed');assert.equal(JSON.parse(readFileSync(join(s.paths.installed,'plugin.json'))).version,newer.version);assert.ok(newClose);assert.equal(readdirSync(join(s.paths.data,'jobs')).length,0);
  }finally{clearInterval(timer);await oldClose?.();await newClose?.();s.clean();}
});

test('packaged README files strip remote badge images for Antigravity plugin overview',()=>{
  for(const name of ['README.md','README_EN.md']){
    const entry=original.files.find(file=>file.path===name);
    assert.ok(entry);
    const text=Buffer.from(entry.data,'base64').toString('utf8');
    assert.equal(text.includes('img.shields.io'),false);
    assert.equal(text.includes('/badge.svg'),false);
    assert.equal(text.includes('plugin-badges:start'),false);
    assert.equal(text.includes('\u00b7'),false);
    assert.ok(text.includes(`v${original.version} | MIT License`));
  }
  assert.ok(readFileSync(resolve('README.md'),'utf8').includes('img.shields.io'));
});

test('install automatically disables legacy agy-powertools and migrates saved settings, goals and accounts without overwriting existing files',async()=>{
  const s=sandbox();let stoppedLegacy=false;try{
    const legacyId=['agy','powertools'].join('-'),legacyData=join(s.paths.root,'antigravity','plugin_data',legacyId);
    mkdirSync(join(legacyData,'runtime'),{recursive:true});
    writeFileSync(join(legacyData,'settings.json'),'{"language":"en"}');
    writeFileSync(join(legacyData,'goals.json'),'{"c1":{"text":"ship"}}');
    writeFileSync(join(legacyData,'accounts.json'),'{"accounts":[{"id":"a1","email":"u@example.com"}]}');
    atomicJson(s.paths.config,{plugins:{other:{enabled:true},[legacyId]:{enabled:true}}});
    const res=await installPlugin({bundle:original,home:s.home,stop:async dir=>{if(dir.includes(legacyId))stoppedLegacy=true;}});
    assert.equal(res.migratedLegacy,true);assert.equal(stoppedLegacy,true);
    const cfg=JSON.parse(readFileSync(s.paths.config,'utf8'));
    assert.equal(cfg.plugins[legacyId].enabled,false);assert.equal(cfg.plugins['agy-max'].enabled,true);
    assert.equal(readFileSync(join(s.paths.data,'settings.json'),'utf8'),'{"language":"en"}');
    assert.equal(readFileSync(join(s.paths.data,'goals.json'),'utf8'),'{"c1":{"text":"ship"}}');
    assert.equal(readFileSync(join(s.paths.data,'accounts.json'),'utf8'),'{"accounts":[{"id":"a1","email":"u@example.com"}]}');
    writeFileSync(join(legacyData,'settings.json'),'{"language":"ja"}');
    await installPlugin({bundle:original,home:s.home,stop});
    assert.equal(readFileSync(join(s.paths.data,'settings.json'),'utf8'),'{"language":"en"}');
  }finally{s.clean();}
});

test('dangling symlinks cannot bypass assertOwnedPath or assertTree during install and uninstall',async()=>{
  const s=sandbox();const linkType=process.platform==='win32'?'junction':'dir';try{
    const externalMissing=join(s.root,'nonexistent-outside');
    const pluginsDir=join(s.paths.root,'config','plugins');
    mkdirSync(pluginsDir,{recursive:true});
    symlinkSync(externalMissing,s.paths.installed,linkType);
    assert.throws(()=>assertOwnedPath(s.paths.home,s.paths.installed),/符号链接/);
    assert.throws(()=>assertOwnedPath(s.paths.home,join(s.paths.installed,'nested','file.txt')),/符号链接/);
    await assert.rejects(()=>installPlugin({bundle:original,home:s.home,stop}),/符号链接/);
    assert.equal(existsSync(externalMissing),false);
    rmSync(s.paths.installed,{force:true});

    await installPlugin({bundle:original,home:s.home,stop});
    symlinkSync(externalMissing,join(s.paths.installed,'dangling-entry'),linkType);
    await assert.rejects(()=>uninstallPlugin({home:s.home,stop}),/符号链接/);
    assert.equal(existsSync(externalMissing),false);
  }finally{s.clean();}
});

test('runtime control loopback requests bypass NODE_USE_ENV_PROXY and HTTP_PROXY',async()=>{
  const s=sandbox();let close,stopped=false,proxyHits=0;
  const proxyServer=createServer((req,res)=>{proxyHits++;res.writeHead(502);res.end('proxy trap');});
  try{
    await new Promise(resolve=>proxyServer.listen(0,'127.0.0.1',resolve));
    const proxyPort=proxyServer.address().port;
    const directory=join(s.paths.data,'runtime');
    close=await serveRuntime({directory,version:original.version,stop:async()=>{stopped=true;},health:async()=>({healthy:true}),exit:()=>{}});
    const modUrl=pathToFileURL(resolve('lib/runtime-control.mjs')).href;
    const script=`import {waitForRuntime,stopRuntimes} from ${JSON.stringify(modUrl)};
      const st=await waitForRuntime(${JSON.stringify(directory)},${JSON.stringify(original.version)},{timeout:3000});
      if(!st.healthy)throw Error('unhealthy');
      await stopRuntimes(${JSON.stringify(directory)},{purge:false});`;
    await new Promise((resolveDone,reject)=>{
      const env={...process.env,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:`http://127.0.0.1:${proxyPort}`,http_proxy:`http://127.0.0.1:${proxyPort}`};
      delete env.NO_PROXY;delete env.no_proxy;
      const child=spawn(process.execPath,['--input-type=module','-e',script],{env,stdio:['ignore','pipe','pipe']});
      let stderr='';child.stderr.on('data',c=>{stderr+=c;});
      child.once('error',reject);
      child.once('exit',code=>code===0?resolveDone():reject(Error(stderr||`exit ${code}`)));
    });
    assert.equal(proxyHits,0,'loopback runtime control must never traverse HTTP_PROXY');
    assert.equal(stopped,true);
    assert.equal(runtimeRecords(directory).length,0);
  }finally{await close?.();await new Promise(r=>proxyServer.close(r));s.clean();}
});

test('mergeLoopbackNoProxy always appends localhost, 127.0.0.1, and ::1 while keeping existing entries',()=>{
  const empty=mergeLoopbackNoProxy({});
  assert.equal(empty.NO_PROXY,'localhost,127.0.0.1,::1');
  assert.equal(empty.no_proxy,'localhost,127.0.0.1,::1');
  const merged=mergeLoopbackNoProxy({NO_PROXY:'internal.corp, LOCALHOST',No_Proxy:'.example.com,127.0.0.1'});
  assert.equal(merged.NO_PROXY,'internal.corp,LOCALHOST,.example.com,127.0.0.1,::1');
  assert.equal(merged.no_proxy,merged.NO_PROXY);
  assert.equal(Object.hasOwn(merged,'No_Proxy'),false);
});

test('maintenance.lock and update.lock recover from corrupt files and invalid PIDs without deadlocking',async()=>{
  const s=sandbox();
  try{
    mkdirSync(s.paths.data,{recursive:true});
    const mLock=join(s.paths.data,'maintenance.lock');
    const uLock=join(s.paths.data,'update.lock');
    const past=new Date(Date.now()-5000);

    // Invalid PIDs (0, -1, non-integer, missing) are replaced immediately
    for(const payload of ['{"pid":0,"nonce":"n1"}','{"pid":-5,"nonce":"n2"}','{"pid":"abc","nonce":"n3"}','{}','null']){
      writeFileSync(mLock,payload);
      const nonce=acquireLockFile(mLock,{busyMessage:'busy'});
      assert.equal(JSON.parse(readFileSync(mLock,'utf8')).pid,process.pid);
      releaseLockFile(mLock,nonce);
      assert.equal(existsSync(mLock),false);
    }

    // Fresh empty/truncated lock file within grace period is treated as busy
    writeFileSync(mLock,'');
    assert.throws(()=>acquireLockFile(mLock,{busyMessage:'busy',corruptGraceMs:2000}),/busy/);

    // Truncated/empty lock file older than grace period is recovered cleanly by installPlugin & startUpdate
    writeFileSync(mLock,'{"pid":');
    utimesSync(mLock,past,past);
    const res=await installPlugin({bundle:older,home:s.home,stop});
    assert.equal(res.version,older.version);
    assert.equal(existsSync(mLock),false);

    writeFileSync(uLock,'');
    utimesSync(uLock,past,past);
    const bytes=encodePackage(newer),name=releaseName(newer.version);
    const fetcher=async()=>new Response(JSON.stringify({tag_name:'v'+newer.version,assets:[{name,state:'uploaded',digest:'sha256:'+sha256(bytes)}]}));
    const started=await startUpdate({home:s.home,currentVersion:older.version,expectedVersion:newer.version,project:{githubUrl:'https://github.com/test/project'},fetcher,launch:async()=>process.pid});
    assert.equal(started.status,'preparing');
    assert.equal(JSON.parse(readFileSync(uLock,'utf8')).pid,process.pid);
  }finally{s.clean();}
});
