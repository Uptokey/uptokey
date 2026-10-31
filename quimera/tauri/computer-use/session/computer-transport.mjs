import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {timingSafeEqual} from 'node:crypto';

/** Narrow, revocable local stdio transport. The child is never a shell. */
export async function nativeComputerTransport({executable,args,env,capability,expiresAt,spawnChild=spawn,onInitialized=()=>{},onStartupError=()=>{},onControl=async()=>{throw Error('Unavailable')},onDisconnected=()=>{}}) {
  if(!/^[a-f0-9]{64}$/.test(capability)||!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now())throw Error('Invalid computer session');
  const sockets=new Set(),children=new Set();let active=false,closed=false,initialized=false;
  const toolNames=['computer_click','computer_key','computer_screenshot','computer_scroll','computer_snapshot','computer_type','computer_windows'];
  const diagnostic={authorizedConnections:0,nativeSpawns:0,nativeExits:0,initializeSeen:false,toolsDiscovered:false,initializationErrorCode:null,nativeStartupErrorCode:null,startupInspectionLimitReached:false};
  const startupErrors=new Set(['target_process_unavailable','target_process_exited','target_window_closed','target_identity_changed','target_not_visible','target_too_large','window_enumeration_denied','window_metadata_unavailable','window_focus_unavailable','mcp_initialization_failed']);
  const server=createServer(socket=>{
    if(closed||sockets.size>=12){socket.destroy();return}
    sockets.add(socket);socket.setNoDelay(true);socket.setTimeout(5000,()=>socket.destroy());
    socket.once('close',()=>sockets.delete(socket));
    let header=Buffer.alloc(0);
    const authorize=chunk=>{
      header=Buffer.concat([header,chunk]);const end=header.indexOf(10);
      if((end<0&&header.length>4096)||end>4096){socket.destroy();return}
      if(end<0)return;
      const supplied=header.subarray(0,Math.min(64,end));
      if(supplied.length!==64||!timingSafeEqual(supplied,Buffer.from(capability))||Date.now()>=expiresAt){socket.destroy();return}
      if(end>64) {
        if(header.subarray(64,71).toString()!==' focus '||end!==header.length-1){socket.destroy();return}
        let input;try{input=JSON.parse(header.subarray(71,end).toString())}catch{socket.destroy();return}
        header.fill(0);socket.off('data',authorize);
        // A control socket carries exactly one bounded frame, never MCP bytes.
        socket.on('data',()=>socket.destroy());
        Promise.resolve().then(()=>onControl(input)).then(value=>{
          if(!socket.destroyed)socket.end(JSON.stringify(value)+'\n');
        },()=>{if(!socket.destroyed)socket.end('{"error":"computer_focus_unavailable"}\n')});
        return;
      }
      if(active||initialized){socket.destroy();return}
      socket.off('data',authorize);socket.setTimeout(0);active=true;
      diagnostic.authorizedConnections++;
      const child=spawnChild(executable,args,{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
      diagnostic.nativeSpawns++;
      children.add(child);const remaining=Buffer.from(header.subarray(end+1));header.fill(0);
      // Do not retain or log protocol messages, screenshots or typed text.
      if(remaining.length)child.stdin.write(remaining);
      socket.pipe(child.stdin);child.stdout.pipe(socket);
      let startup=Buffer.alloc(0),inspectedBytes=0,startupError=Buffer.alloc(0);
      const stopError=()=>{child.stderr?.off('data',observeError);child.stderr?.resume();startupError.fill(0);startupError=Buffer.alloc(0)};
      const stopObserving=()=>{child.stdout.off('data',observe);startup.fill(0);startup=Buffer.alloc(0);stopError()};
      // Only fixed backend startup codes cross this boundary. Never retain raw
      // stderr, window titles, typed text, protocol messages or paths.
      const observeError=chunk=>{
        if(startupError.length+chunk.length>128){stopError();return}
        startupError=Buffer.concat([startupError,chunk]);
        const end=startupError.indexOf(10);if(end<0)return;
        const code=startupError.subarray(0,end).toString().trim();stopError();
        if(startupErrors.has(code)){diagnostic.nativeStartupErrorCode=code;onStartupError(code);close()}
      };
      const observe=chunk=>{
        inspectedBytes+=chunk.length;
        if(inspectedBytes>65536){diagnostic.startupInspectionLimitReached=true;stopObserving();return}
        startup=Buffer.concat([startup,chunk]);
        for(let end;(end=startup.indexOf(10))>=0;){
          const line=startup.subarray(0,end),remaining=Buffer.from(startup.subarray(end+1));
          let ready=false;
          try{
            const value=JSON.parse(line.toString());
            if(typeof value.result?.protocolVersion==='string')diagnostic.initializeSeen=true;
            // Current MCP negotiates server/discover on a disposable sibling
            // and may never send initialize. The live client's tools/list is
            // the common readiness boundary for both supported lifecycles.
            if(Array.isArray(value.result?.tools)){
              const names=value.result.tools.map(tool=>tool?.name).sort();
              ready=names.length===toolNames.length&&names.every((name,index)=>name===toolNames[index]);
            }
            else if(Object.hasOwn(value,'id')&&Number.isInteger(value.error?.code))diagnostic.initializationErrorCode=value.error.code;
          }catch{}
          startup.fill(0);startup=remaining;
          if(ready){diagnostic.toolsDiscovered=true;initialized=true;stopObserving();onInitialized();return}
        }
      };
      child.stdout.on('data',observe);
      child.stderr?.on('data',observeError);
      child.stdin.on('error',()=>socket.destroy());child.stdout.on('error',()=>socket.destroy());
      let finished=false;
      const finish=()=>{if(finished)return;finished=true;diagnostic.nativeExits++;active=false;children.delete(child);stopObserving();socket.destroy();if(initialized){onDisconnected();close()}};
      child.once('error',finish);child.once('exit',finish);
      socket.once('close',()=>{child.stdin.end();child.kill();if(initialized){onDisconnected();close()}});
    };
    socket.on('data',authorize);socket.on('error',()=>{});
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)});
  const close=()=>{if(closed)return;closed=true;clearTimeout(timer);for(const socket of sockets)socket.destroy();for(const child of children){child.stdin.end();child.kill()}server.close()};
  const timer=setTimeout(close,Math.min(2**31-1,expiresAt-Date.now()));timer.unref();
  return {port:server.address().port,close,ready:()=>initialized&&active&&!closed,diagnostic:()=>({...diagnostic,active,closed})};
}
