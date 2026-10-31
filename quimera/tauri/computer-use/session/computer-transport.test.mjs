import test from 'node:test';
import assert from 'node:assert/strict';
import {connect} from 'node:net';
import {once} from 'node:events';
import {nativeComputerTransport} from './computer-transport.mjs';
import {createFocusTickets} from './computer-focus-tickets.mjs';
import {focusControl} from '../../../../experiments/deepseek-workbench/runtime/integrations/computer-focus-client.mjs';
const capability='a'.repeat(64);
const toolNames=['computer_click','computer_key','computer_screenshot','computer_scroll','computer_snapshot','computer_type','computer_windows'];
const correlation={sessionId:'session',callId:'call',toolName:'mcp__computer__computer_type',fingerprint:'b'.repeat(64)};

test('authenticated control and canonical MCP coexist; control never spawns or carries tool bytes',async()=>{
  const initialized=Promise.withResolvers();let tickets;const frames=[];
  const tools=toolNames.map(name=>({name}));
  const transport=await nativeComputerTransport({executable:process.execPath,args:['-e',`process.stdin.once('data',()=>process.stdout.write(JSON.stringify({id:1,result:{tools:${JSON.stringify(tools)}}})+'\\n'));process.stdin.resume()`],env:{},capability,expiresAt:Date.now()+10000,onInitialized:initialized.resolve,onControl:value=>tickets.request(value),onDisconnected:()=>tickets.close()});
  const lease={port:transport.port,capability,id:'c'.repeat(32),expiresAt:Date.now()+10000};
  tickets=createFocusTickets({leaseId:lease.id,expiresAt:lease.expiresAt,required:true,isReady:()=>transport.ready(),notify:frame=>{frames.push(frame);if(frame.type==='focus-register')tickets.acknowledge({type:'focus-registered',id:frame.ticket.id})}});
  const socket=connect(transport.port,'127.0.0.1');socket.on('data',()=>{});socket.on('error',()=>{});
  try {
    await once(socket,'connect');socket.write(capability+'\n{}\n');await initialized.promise;
    const result=await focusControl(lease,{operation:'prepare',correlation});assert.equal(result.required,true);
    assert.equal(frames.length,1);assert.equal(transport.diagnostic().nativeSpawns,1);
    tickets.acknowledge({type:'focus-approved',id:result.ticket.id});
    assert.deepEqual(await focusControl(lease,{operation:'consume',ticket:result.ticket}),{consumed:true});
    await assert.rejects(focusControl(lease,{operation:'consume',ticket:result.ticket}));
    assert.equal(transport.diagnostic().nativeSpawns,1);assert.equal(transport.ready(),true);
    const second=await focusControl(lease,{operation:'prepare',correlation});
    const closed=once(socket,'close');socket.destroy();await closed;
    // Closing the live MCP side revokes the whole owner, so a new data client
    // cannot inherit readiness or an approval from a previous Rust process.
    await assert.rejects(focusControl(lease,{operation:'consume',ticket:second.ticket}));
  }finally{tickets.close();transport.close();socket.destroy();}
});

test('MCP payload coalesced after the auth line remains opaque above control-frame limit',async()=>{
  const t=await nativeComputerTransport({executable:process.execPath,args:['-e','process.stdin.pipe(process.stdout)'],env:{},capability,expiresAt:Date.now()+5000});
  const socket=connect(t.port,'127.0.0.1');socket.on('error',()=>{});
  try {
    await once(socket,'connect');const content='x'.repeat(10000)+'\n';let received='';const complete=Promise.withResolvers();
    socket.on('data',chunk=>{received+=chunk.toString();if(received.length>=content.length)complete.resolve()});
    socket.write(capability+'\n'+content);await complete.promise;assert.equal(received,content);
  }finally{t.close();socket.destroy();}
});

test('wrong capability, extra control bytes and oversized header never invoke control or spawn',async()=>{
  let calls=0,spawns=0;
  const t=await nativeComputerTransport({executable:'unused',args:[],env:{},capability,expiresAt:Date.now()+5000,onControl:()=>{calls++;return{}},spawnChild:()=>{spawns++;throw Error('unexpected')}});
  try{for(const frame of ['b'.repeat(64)+' focus {}\n',capability+' focus {}\n{"method":"tools/call"}\n','x'.repeat(4097)]){
    const socket=connect(t.port,'127.0.0.1');socket.on('error',()=>{});await once(socket,'connect');const closed=once(socket,'close');socket.write(frame);await closed;
  }assert.equal(calls,0);assert.equal(spawns,0)}finally{t.close()}
});
