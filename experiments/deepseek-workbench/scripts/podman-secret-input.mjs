import {spawnSync} from 'node:child_process';

/** Podman 4.9 requires stdin to be a FIFO; Node's pipe is a Unix socket.
 * A fixed shell pipeline creates an anonymous OS pipe. The input remains on
 * stdin and is never placed in an argument, environment variable or file.
 */
export function podmanSecretInput(args,{env,input,platform=process.platform,spawn=spawnSync}={}){
 if(!Array.isArray(args)||args.at(-1)!=='-'||!args.includes('secret')||!args.includes('create')||typeof input!=='string')throw Error('podman_secret_input_invalid');
 const options={env,input,encoding:'utf8',windowsHide:true};
 if(platform==='linux'||platform==='darwin'){
  return spawn('/bin/sh',['-c','/bin/cat | "$@"','uptokey-stdin','podman',...args],options);
 }
 return spawn('podman',args,options);
}
