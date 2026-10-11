import { TuiClient } from './tui/client.ts';
import { storedTuiToken } from './tui/auth.ts';
import { createOfficialSecretStore, assertSecretStoreBoundary, type SecretStore } from './secret-store.ts';
import { readBoundedJson } from '@uptokey/sync-contract/limits';

const BASE_URL = 'http://127.0.0.1:21435';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const PUBLIC_ERRORS = new Set(['unauthorized','context_link_invalid_request','context_scope_denied','context_link_invalid','context_not_owned','context_link_pending_or_expired','context_link_conflict','context_project_required','local_auth_rate_limited','tui_client_identity_invalid','tui_client_identity_unavailable','tui_native_key_missing','tui_native_key_invalid','tui_native_key_unavailable']);
export type WorkspaceContextApproval = { id: string; userCode: string; conversationId: string; expectedRevision: number };
export type WorkspaceContextMetadata = { id: string; title: string; revision: number; projectId: string };
const record = (value: unknown): value is Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function parseWorkspaceContextApproval(value: unknown): WorkspaceContextApproval {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'conversationId,expectedRevision,id,userCode' || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.conversationId !== 'string' || !CONVERSATION.test(value.conversationId) || typeof value.userCode !== 'string' || !/^[a-f0-9]{8}$/i.test(value.userCode) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new Error('context_link_invalid_request');
  return { id:value.id,userCode:value.userCode,conversationId:value.conversationId,expectedRevision:Number(value.expectedRevision) };
}
export function projectWorkspaceContexts(value: unknown): WorkspaceContextMetadata[] {
  if (!record(value) || !Array.isArray(value.contexts) || value.contexts.length > 50) throw new Error('context_link_invalid_response');
  const seen = new Set<string>();
  return value.contexts.map(item => {
    if (!record(item) || typeof item.id !== 'string' || !CONVERSATION.test(item.id) || seen.has(item.id) || typeof item.projectId !== 'string' || !PROJECT.test(item.projectId) || typeof item.title !== 'string' || item.title.length > 256 || /[\u0000-\u001f\u007f]/.test(item.title) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1) throw new Error('context_link_invalid_response');
    seen.add(item.id);
    return { id:item.id,title:item.title,revision:Number(item.revision),projectId:item.projectId };
  });
}
export async function workspaceContextOperation(operation: 'list'|'approve', input: unknown, dependencies: { secrets?: SecretStore; fetch?: typeof fetch; token?: (client: TuiClient,secrets: SecretStore) => Promise<string|undefined> } = {}): Promise<{contexts:WorkspaceContextMetadata[]}|{approved:true}> {
  const approval = operation === 'approve' ? parseWorkspaceContextApproval(input) : undefined;
  const official=dependencies.secrets?undefined:createOfficialSecretStore();
  if(official) assertSecretStoreBoundary(official.securityBoundary());
  const store=dependencies.secrets ?? official!;
  const client=new TuiClient({baseUrl:BASE_URL,requestTimeoutMs:5_000});
  try {
    const token=await (dependencies.token ?? storedTuiToken)(client,store);
    if (!token) throw new Error('tui_client_identity_unavailable');
    const path=operation==='list'?'/local/workspace/session/context/owned':'/local/workspace/session/context/approve';
    const response=await (dependencies.fetch ?? fetch)(BASE_URL+path,{method:approval?'POST':'GET',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(approval?{body:JSON.stringify(approval)}:{}),signal:AbortSignal.timeout(10_000),redirect:'error'});
    const parsed=await readBoundedJson(response,65_536);
    if (!parsed.ok) throw new Error('context_link_invalid_response');
    const value=parsed.value;
    if (!response.ok) {
      const code=record(value)&&record(value.error)&&typeof value.error.type==='string'?value.error.type:'';
      throw new Error(PUBLIC_ERRORS.has(code)?code:response.status===401?'unauthorized':'context_link_failed');
    }
    if (operation==='list') return {contexts:projectWorkspaceContexts(value)};
    if (!record(value) || value.approved!==true || Object.keys(value).length!==1) throw new Error('context_link_invalid_response');
    return {approved:true};
  } finally { client.destroy(); }
}
/** Internal native adapter protocol. Credentials never enter argv, output or the WebView. */
export async function runWorkspaceContextCli(args:string[]):Promise<void> {
  try {
    const operation=args[0];
    if (args.length!==1 || operation===undefined || !['list','approve'].includes(operation)) throw new Error('context_link_invalid_request');
    let input:unknown;
    if(operation==='approve') {
      let bytes=0;const chunks:Buffer[]=[];
      for await (const chunk of process.stdin) { const b=Buffer.from(chunk);bytes+=b.length;if(bytes>4_096)throw new Error('context_link_invalid_request');chunks.push(b); }
      try {input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('context_link_invalid_request');}
    }
    const result=await workspaceContextOperation(operation as 'list'|'approve',input);
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch(error) {
    const candidate=error instanceof Error?error.message:'';
    const code=PUBLIC_ERRORS.has(candidate)||['context_link_invalid_response','context_link_invalid_request'].includes(candidate)?candidate:'context_link_failed';
    process.stdout.write(JSON.stringify({error:{code}})+'\n');process.exitCode=1;
  }
}
