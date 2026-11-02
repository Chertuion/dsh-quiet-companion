import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { launchNativeHelper } from './helper.mjs';

const fixture=`
const net=require('node:net');
const socket=net.connect(process.argv[1]);
socket.on('connect',()=>socket.write(JSON.stringify({type:'ready',pid:process.pid,ipcToken:process.argv[2]})+'\\n'));
let buffer='';socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\\n')){
 const at=buffer.indexOf('\\n'),message=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
 if(message.type==='shutdown'){socket.end();process.exitCode=0;return;}
 socket.write(JSON.stringify({type:'echo',value:message})+'\\n');
}});socket.on('close',()=>process.exit());socket.on('error',()=>process.exit());
`;
test('private live socket authenticates, flushes state, strips handshake secrets and disposes owned process',async t=>{
  const messages=[];let socketPath,mode;
  const helper=launchNativeHelper({appPath:'/synthetic.app',onMessage:m=>messages.push(m),
    launchProcess:options=>{
      socketPath=options.socketPath;
      mode=statSync(socketPath).mode&0o777;
      return spawn(process.execPath,['-e',fixture,socketPath,options.token],{stdio:'ignore'});
    }});
  t.after(()=>helper.dispose());
  helper.send({type:'settings',settings:{observationEnabled:false}});
  await helper.ready;
  assert.equal(helper.state.running,true);
  assert.equal(mode,0o600);
  for(let i=0;i<30&&!messages.some(m=>m.type==='echo');i++) await new Promise(r=>setTimeout(r,2));
  assert.ok(messages.some(m=>m.type==='echo'&&m.value.settings.observationEnabled===false));
  assert.ok(messages.every(m=>!('ipcToken' in m)&&!('pid' in m)));
  await helper.dispose();
  assert.equal(helper.state.running,false);
  await assert.rejects(stat(socketPath),{code:'ENOENT'});
});
test('wrong socket token cannot become a running helper or publish messages',async t=>{
  let messages=0;
  const helper=launchNativeHelper({appPath:'/synthetic.app',readyTimeoutMs:120,onMessage:()=>messages++,
    launchProcess:options=>spawn(process.execPath,['-e',fixture,options.socketPath,'wrong-token'],{stdio:'ignore'})});
  t.after(()=>helper.dispose());
  await assert.rejects(helper.ready);
  assert.equal(helper.state.running,false);assert.equal(messages,0);
  await helper.dispose();
});
