import { parseTerminalCreate, parseTerminalInput, parseTerminalResize, parseTerminalClose, TerminalContractError } from '@uptokey/sync-contract/interactive-terminal';
import { resolveBearer } from '../client-keys.ts';
import type { SecretStore } from '../secret-store.ts';
import type { WorkspaceRuntime } from './runtime.ts';
import { InteractiveTerminalError, type TerminalAuthority } from './interactive-terminal.ts';
import { isProjectGranted, type LocalProjectGrant } from './principal.ts';

const id='[A-Za-z0-9][A-Za-z0-9_-]{0,99}';
const route=new RegExp(`^/v1/workspace/projects/(${id})/terminals(?:/(${id})/(events|input|resize|close))?$`);
export function terminalRouteMethod(path:string,method?:string):'GET'|'POST'|undefined {
  const match=route.exec(path);if(!match)return;
  if(!match[2])return method==='GET'?'GET':'POST';
  return match[3]==='events'?'GET':'POST';
}
export function terminalQuery(url:URL):boolean {
  const match=route.exec(url.pathname);return Boolean(match?.[3]==='events'&&[...url.searchParams.keys()].every(key=>key==='after')&&url.searchParams.getAll('after').length<=1&&/^(0|[1-9][0-9]{0,15})$/.test(url.searchParams.get('after')??'0')&&Number.isSafeInteger(Number(url.searchParams.get('after')??0)));
}

/** A fresh local credential/root grant is checked at every read, write, resize and after long-poll.
 * Cloud account login and model API keys cannot grant this host capability. */
export async function terminalAuthority(header:string|undefined,owner:string,projectId:string,secrets:SecretStore|undefined,
  principal:(header:string|undefined)=>Promise<string|undefined>,projectGrant?: (header:string|undefined)=>Promise<LocalProjectGrant|undefined>):Promise<TerminalAuthority> {
  if(!secrets)throw new InteractiveTerminalError('terminal_authority_unavailable',503);
  let admitted:string|undefined;
  const validate=async()=>{
    const token=/^Bearer (\S+)$/i.exec(header??'')?.[1],result=await resolveBearer(secrets,token);
    if(!result.ok||result.resolved.delegation)throw new InteractiveTerminalError('terminal_authority_revoked',403);
    const client=result.resolved;
    if(client.kind!=='admin'&&(!['pwa','tauri'].includes(client.registration?.audience??'')||!client.registration||client.policy?.retentionMode==='ephemeral'))throw new InteractiveTerminalError('terminal_access_denied',403);
    const fingerprint=JSON.stringify([client.kind,client.clientId,client.registration,client.policy]);
    if(admitted!==undefined&&fingerprint!==admitted)throw new InteractiveTerminalError('terminal_authority_revoked',403);
    if(await principal(header)!==owner||!isProjectGranted(projectGrant?await projectGrant(header)??[]:'*',projectId))throw new InteractiveTerminalError('terminal_authority_revoked',403);
    admitted=fingerprint;
  };await validate();return validate;
}

export async function handleTerminal(runtime:WorkspaceRuntime,owner:string,projectId:string,parts:string[],method:string,input:unknown,url:URL,authority:TerminalAuthority,signal:AbortSignal):Promise<unknown> {
  const service=runtime.interactiveTerminals;
  try{
    if(parts.length===3)return method==='GET'?service.list(owner,projectId,authority):service.create(owner,projectId,parseTerminalCreate(input),authority);
    const sessionId=parts[3]!;
    if(parts.length!==5)throw new InteractiveTerminalError('terminal_missing',404);
    if(parts[4]==='events'&&method==='GET'){
      if(!terminalQuery(url))throw new InteractiveTerminalError('terminal_cursor_invalid');
      return service.read(owner,projectId,sessionId,Number(url.searchParams.get('after')??0),authority,signal);
    }
    if(method==='POST'&&parts[4]==='input')return service.input(owner,projectId,sessionId,parseTerminalInput(input),authority);
    if(method==='POST'&&parts[4]==='resize')return service.resize(owner,projectId,sessionId,parseTerminalResize(input),authority);
    if(method==='POST'&&parts[4]==='close'){parseTerminalClose(input);return service.closeSession(owner,projectId,sessionId,authority);}
    throw new InteractiveTerminalError('terminal_missing',404);
  }catch(error){if(error instanceof TerminalContractError)throw new InteractiveTerminalError('terminal_request_invalid');throw error;}
}
