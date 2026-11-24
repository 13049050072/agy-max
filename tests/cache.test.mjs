import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheObservation} from '../lib/cache.mjs';
test('cache observation countdown is explicitly estimated and never invents server expiration',()=>{
  const request={timestampMs:1000,model:'Gemini 4 Carbon',inputTokens:10,cacheReadTokens:90};
  const first=cacheObservation([request],61000);
  assert.equal(first.remainingMs,240000);assert.equal(first.hitPercent,90);
  assert.equal(first.estimated,true);assert.equal(first.serverExpiresAtMs,null);
  const elapsed=cacheObservation([request],401000);assert.equal(elapsed.remainingMs,0);assert.equal(elapsed.serverExpiresAtMs,null);
  assert.equal(cacheObservation([request],500),null);
  assert.equal(cacheObservation([],61000),null);
  assert.equal(cacheObservation([{...request,error:'failed'}],61000),null);
  assert.equal(cacheObservation([{...request,model:'Unknown'}],61000).remainingMs,null);
  assert.equal(cacheObservation([request,{...request,timestampMs:2000,cacheReadTokens:0}],61000).hitPercent,0);
});
