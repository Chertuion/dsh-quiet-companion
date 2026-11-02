/** Settings RPC framing over rc5's authenticated, owner-only exact Fetch routes. */
const PREFIX='quiet-companion/';
const ENDPOINTS=['snapshot','update-settings','action'];
const MAX_BODY_BYTES=128*1024;
const failure=(code,message)=>({ok:false,error:{code,message,details:{}}});
const reply=(rpcId,result)=>Response.json({type:'server-response',rpcId,result});
const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/**
 * Connection checks Host/Origin and credentials before dispatch, then rejects
 * every non-owner Peer on exact routes. Its real browser owner Peer is safe
 * to pass to the settings handler; caller cancellation remains request.signal.
 * This uses Fetch routes because rc5's rpc.handle closure loses webServer's
 * injection scope. No alternate HTTP server or authentication bypass is used.
 */
export function registerSettingsChannel(ctx,handler) {
  const connection=ctx.connection;
  const owner=connection.browserPeer;
  if(owner?.principal?.kind!=='owner'||typeof connection.fetch?.register!=='function') {
    throw new Error('Harness 的已认证设置服务尚未就绪。');
  }
  const disposers=[];
  let closed=false,disposing;
  try {
    for(const endpoint of ENDPOINTS) {
      disposers.push(connection.fetch.register({
        path:'/api/'+PREFIX+endpoint,methods:['POST'],requestBody:'buffered',
        fetch:async request=>{
          if(closed) return new Response(null,{status:503});
          if(request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json') {
            return new Response(null,{status:415});
          }
          const declared=request.headers.get('content-length');
          if(declared!==null&&Number(declared)>MAX_BODY_BYTES) return new Response(null,{status:413});
          let envelope;
          try {
            const body=await request.text();
            if(Buffer.byteLength(body,'utf8')>MAX_BODY_BYTES) return new Response(null,{status:413});
            envelope=JSON.parse(body);
          } catch {return new Response(null,{status:400});}
          if(!isRecord(envelope)||envelope.type!=='client-request'
              ||typeof envelope.rpcId!=='string'||!envelope.rpcId||envelope.rpcId.length>128
              ||envelope.method!==PREFIX+endpoint||!Object.hasOwn(envelope,'payload')) {
            return new Response(null,{status:400});
          }
          if(closed) return new Response(null,{status:503});
          try {
            request.signal.throwIfAborted();owner.signal?.throwIfAborted();
            const result=await handler(endpoint,envelope.payload,request.signal,owner);
            return reply(envelope.rpcId,result);
          } catch {
            return reply(envelope.rpcId,failure('operation-failed','操作未完成，请检查陪伴组件状态。'));
          }
        },
      }));
    }
  } catch(error) {
    closed=true;
    void Promise.allSettled(disposers.map(dispose=>dispose()));
    throw error;
  }
  return ()=>{
    if(disposing) return disposing;
    closed=true;
    disposing=Promise.allSettled(disposers.map(dispose=>dispose()));
    return disposing;
  };
}
