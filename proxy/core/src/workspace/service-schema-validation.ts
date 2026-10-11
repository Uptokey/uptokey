import {Worker} from 'node:worker_threads';
let activeWorkers=0;
/** Remote schemas are untrusted: compilation and regex matching never run on the application thread. */
export async function validateServiceInput(schema:Record<string,unknown>,parameters:Record<string,unknown>):Promise<void>{
 if(JSON.stringify(schema).length>65536||JSON.stringify(parameters).length>65536||activeWorkers>=4)throw new Error('service_input_invalid');
 activeWorkers++;
 let worker:Worker|undefined;
 try{
  worker=new Worker(new URL(import.meta.url.endsWith('.ts')?'./service-schema-worker.ts':'./service-schema-worker.js',import.meta.url),{
   workerData:{schema,parameters},env:{},execArgv:import.meta.url.endsWith('.ts')?['--experimental-strip-types']:[],
   resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:2},stdout:true,stderr:true,
  });
  worker.stdout?.resume();worker.stderr?.resume();
  await new Promise<void>((resolve,reject)=>{
   let ready=false,settled=false;
   let timer=setTimeout(()=>finish(false),5000);
   const finish=(valid:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);valid?resolve():reject(new Error('service_input_invalid'));};
   worker!.on('message',(message:unknown)=>{
    if(!message||typeof message!=='object')return finish(false);
    const value=message as {ready?:boolean;valid?:boolean};
    if(value.ready===true&&!ready){ready=true;clearTimeout(timer);timer=setTimeout(()=>finish(false),500);return;}
    finish(ready&&value.valid===true);
   });
   worker!.once('error',()=>finish(false));worker!.once('exit',()=>finish(false));
  });
 }finally{if(worker)await worker.terminate().catch(()=>undefined);activeWorkers--;}
}
