import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeDeclarationCache,declaredNativeNames} from '../lib/native-cache.mjs';

test('component cache reuses validated names across reconnects and processes, but refreshes changed builds',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'agy-component-cache-'));let parses=0;
  let source='var Alpha=1;',etag='"a"';const calls=[];
  const request=async(origin,headers)=>{calls.push({origin,headers});return headers['If-None-Match']===etag?{status:304}:{status:200,source,headers:{etag}};};
  const parse=text=>{parses++;return declaredNativeNames(text);};
  try{
    const discover=createNativeDeclarationCache({directory,request,parse});
    assert.deepEqual(await discover('https://127.0.0.1:1',{version:'2.32.1'}),['Alpha']);
    assert.deepEqual(await discover('https://127.0.0.1:2',{version:'2.32.1'}),['Alpha']);assert.equal(parses,1);
    const next=createNativeDeclarationCache({directory,request,parse});
    assert.deepEqual(await next('https://127.0.0.1:3',{version:'2.32.1'}),['Alpha']);assert.equal(parses,1);
    source='const Beta=2;';etag='"b"';
    assert.deepEqual(await next('https://127.0.0.1:3',{version:'2.32.1'}),['Beta']);assert.equal(parses,2);
    assert.deepEqual(await next('https://127.0.0.1:3',{version:'2.33.0'}),['Beta']);assert.equal(parses,3);
    assert.deepEqual(calls.at(-1).headers,{});
    await next('https://127.0.0.1:3',{version:'2.33.0',force:true});assert.equal(parses,4);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('component cache checks source hashes without validators and rejects corrupt stored names',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'agy-component-cache-'));let parses=0,requests=0;
  const request=async()=>{requests++;return{status:200,source:'let Current=1;',headers:{}};};
  const parse=text=>{parses++;return declaredNativeNames(text);};
  try{
    const discover=createNativeDeclarationCache({directory,request,parse});
    await discover('https://127.0.0.1:1',{version:'2.32.1'});await discover('https://127.0.0.1:1',{version:'2.32.1'});
    assert.equal(requests,2);assert.equal(parses,1);
    const file=join(directory,readdirSync(directory)[0]),record=JSON.parse(readFileSync(file,'utf8'));record.names=['Wrong'];writeFileSync(file,JSON.stringify(record));
    assert.deepEqual(await createNativeDeclarationCache({directory,request,parse})('https://127.0.0.1:1',{version:'2.32.1'}),['Current']);assert.equal(parses,2);
    const broken=createNativeDeclarationCache({directory,request:async()=>{throw Error('offline');}});
    await assert.rejects(()=>broken('https://127.0.0.1:1',{version:'2.32.1'}),/offline/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('concurrent component discovery shares one download and storage failure does not block startup',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'agy-component-cache-'));const file=join(directory,'file');writeFileSync(file,'not a directory');let requests=0;
  const discover=createNativeDeclarationCache({directory:file,request:async()=>{requests++;await new Promise(r=>setTimeout(r,5));return{status:200,source:'var Ready=1;',headers:{}};}});
  try{const values=await Promise.all([discover('https://127.0.0.1:1',{version:'2.32.1'}),discover('https://127.0.0.1:1',{version:'2.32.1'})]);assert.equal(requests,1);assert.deepEqual(values,[['Ready'],['Ready']]);}
  finally{rmSync(directory,{recursive:true,force:true});}
});

test('component discovery falls back to page-context fetch when direct Node request fails (SSH window origin)',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'agy-component-fallback-'));let fallbackCalls=0;
  const discover=createNativeDeclarationCache({directory,request:async()=>{throw Object.assign(new Error('connect ECONNREFUSED'),{code:'ECONNREFUSED'});}});
  try{
    const names=await discover('https://127.0.0.1:45678',{
      version:'2.33.0',
      fallbackFetch:async()=>{fallbackCalls++;return{status:200,source:'const PageBound=1;',headers:{}};}
    });
    assert.equal(fallbackCalls,1);
    assert.deepEqual(names,['PageBound']);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
