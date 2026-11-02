import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSettingsChannel } from './host-channel.mjs';

function fixture(handler=async()=>({ok:true,value:{ready:true}})) {
  const routes=new Map(),removed=[];
  const owner={principal:{kind:'owner'},signal:new AbortController().signal};
  const ctx={connection:{browserPeer:owner,fetch:{register(route){
    routes.set(route.path,route);
    return async()=>{removed.push(route.path);routes.delete(route.path);};
  }}}};
  return {routes,removed,owner,dispose:registerSettingsChannel(ctx,handler)};
}
const request=(endpoint,payload={},extra={})=>new Request('http://127.0.0.1/api/quiet-companion/'+endpoint,{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({type:'client-request',rpcId:'fixture-rpc',method:'quiet-companion/'+endpoint,payload,...extra}),
});

test('exact authenticated settings routes preserve Connection framing and real owner identity',async t=>{
  let called;
  const f=fixture(async(...args)=>{called=args;return {ok:true,value:{saved:true}};});t.after(f.dispose);
  assert.deepEqual([...f.routes.keys()],['snapshot','update-settings','action'].map(id=>'/api/quiet-companion/'+id));
  const route=f.routes.get('/api/quiet-companion/update-settings');
  assert.deepEqual(route.methods,['POST']);assert.equal(route.requestBody,'buffered');
  const req=request('update-settings',{patch:{memoryEnabled:false}});
  const response=await route.fetch(req);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{type:'server-response',rpcId:'fixture-rpc',result:{ok:true,value:{saved:true}}});
  assert.equal(called[0],'update-settings');assert.deepEqual(called[1],{patch:{memoryEnabled:false}});
  assert.equal(called[2],req.signal);assert.equal(called[3],f.owner);
});
test('malformed, mismatched and oversized requests never reach the settings handler',async t=>{
  let calls=0;const f=fixture(async()=>{calls++;});t.after(f.dispose);
  const fetch=f.routes.get('/api/quiet-companion/snapshot').fetch;
  assert.equal((await fetch(request('snapshot',{}, {method:'quiet-companion/action'}))).status,400);
  assert.equal((await fetch(request('snapshot',{}, {rpcId:''}))).status,400);
  assert.equal((await fetch(new Request('http://127.0.0.1/',{method:'POST',body:'{}'}))).status,415);
  assert.equal((await fetch(request('snapshot',{text:'x'.repeat(128*1024)}))).status,413);
  assert.equal(calls,0);
});
test('unexpected handler failures stay bounded and keep the failure envelope parseable',async t=>{
  const f=fixture(async()=>{throw new Error('synthetic-private-diagnostic');});t.after(f.dispose);
  const response=await f.routes.get('/api/quiet-companion/snapshot').fetch(request('snapshot'));
  const result=await response.json();
  assert.equal(result.result.ok,false);assert.deepEqual(result.result.error.details,{});
  assert.equal(JSON.stringify(result).includes('synthetic-private-diagnostic'),false);
});
test('disposal removes every owned route once and refuses stale callbacks',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;});
  const fetch=f.routes.get('/api/quiet-companion/snapshot').fetch;
  await Promise.all([f.dispose(),f.dispose()]);
  assert.equal(f.removed.length,3);assert.equal(f.routes.size,0);
  assert.equal((await fetch(request('snapshot'))).status,503);assert.equal(calls,0);
});
test('registration requires the Host owner identity and authenticated exact route service',()=>{
  assert.throws(()=>registerSettingsChannel({connection:{browserPeer:{principal:{kind:'other'}}}},()=>{}),/设置服务/);
});
