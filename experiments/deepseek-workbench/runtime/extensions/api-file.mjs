import {defineTool} from '@deepseek-ai/dsh-tools';
import {apiToFile,createApiFileVerifier} from './api-file-pipeline.mjs';
import {registeredApiPrefixes} from './api-file-registry.mjs';
import {openSync,fstatSync,readFileSync,closeSync,constants} from 'node:fs';
import {parse} from 'yaml';
export const name='uptokey-api-file';
export const inject=['tools','fs'];
export function apply(ctx,config={}){
 const servers=config.servers??[];
 if(!Array.isArray(servers)||servers.some(id=>!/^mcp__[a-z][a-z0-9-]{0,31}__$/.test(id)))throw Error('api_file_registration_invalid');
 const currentServers=()=>{
  const fd=openSync('/home/node/.dsh/profiles/web/cordis.patch.yml',constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024)throw Error('api_file_registry_invalid');
   return registeredApiPrefixes(servers,parse(readFileSync(fd,'utf8')));
  }finally{closeSync(fd);}
 };
 ctx.tools.register(defineTool({
  name:'api_to_file',
  description:'Call a registered public API and save its exact JSON response to a file, then verify the saved file. Use this for API-to-file requests instead of retyping the response. Native file permissions and change tracking apply.',
  parameters:{api_tool:{type:'string',required:true},api_arguments:{type:'object',required:true,additionalProperties:true,description:'Parameters passed directly to the API tool.'},file_path:{type:'string',required:true,description:'Destination JSON file in the permitted workspace.'}},
  output:{schema:{type:'string'},render:(_args,path)=>[{type:'text',text:'Verified JSON file: '+path}]},
  async execute(args,exec){
   const verifier=createApiFileVerifier(ctx.fs,exec);
   const off=ctx.on('fs/observed',verifier.observe);
   try{return await apiToFile(ctx.tools,exec,args,currentServers(),verifier.verify);}
   finally{off();verifier.clear();}
  },
 }));
}
