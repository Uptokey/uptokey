import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import schema from '@deepseek-ai/schemastery';
import SshConnection from '@deepseek-ai/dsh-ssh';
const require=createRequire(import.meta.url);
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export default class WorkbenchConnection extends SshConnection {
 static Config=schema.object({});
 constructor(ctx){
  const helper=require.resolve('@deepseek-ai/dsh-ssh/helper');
  const bootstrapPath='/opt/harness/node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js';
  super(ctx,SshConnection.Config({host:'workbench-executor',helper,helperHash:digest(helper),workspace:'/workspace/demo',launch:{kind:'node-script',node:'/usr/local/bin/node',bootstrapPath,bootstrapHash:digest(bootstrapPath)}}));
 }
}
