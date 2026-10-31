// A byte transport for the native Rust MCP server, not a model/authentication proxy.
// The one-session capability lives only in controller tmpfs and the native owner.
import {readFileSync,lstatSync} from 'node:fs';
import {connect} from 'node:net';
const path='/tmp/uptokey-computer-session.json';
const meta=lstatSync(path);
if(!meta.isFile()||meta.isSymbolicLink()||(meta.mode&0o077)!==0||meta.size>2048)throw Error('Computer use is not enabled');
const state=JSON.parse(readFileSync(path,'utf8'));
if(state.port!==43196||state.id!==process.argv[2]||!Number.isSafeInteger(state.expiresAt)||state.expiresAt<=Date.now()||!/^([a-f0-9]{64})$/.test(state.capability))throw Error('Computer session is unavailable');
const socket=connect({host:'127.0.0.1',port:43196});
socket.setNoDelay(true);
const expiry=setTimeout(()=>socket.destroy(),state.expiresAt-Date.now());expiry.unref();
socket.once('connect',()=>{socket.write(state.capability+'\n');process.stdin.pipe(socket);socket.pipe(process.stdout)});
socket.once('error',()=>{process.stderr.write('Computer session disconnected\n');process.exitCode=1});
socket.once('close',()=>{clearTimeout(expiry);process.stdin.destroy()});
process.stdin.once('end',()=>socket.end());
process.stdout.once('error',()=>socket.destroy());
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>socket.destroy());
