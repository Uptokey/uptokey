import { createHash } from 'node:crypto';
import { parseCapabilityDescriptor } from '@uptokey/sync-contract/workflow';
import { canonicalStringify } from '../importer.ts';
import type { ProductivityOperation, PreparedProductivityCall, EffectPreview } from './operations.ts';

/**
 * Resend — envio de correspondência revisável (efeito externo, sem rollback).
 * Documentação oficial: https://resend.com/docs/api-reference/emails/send-email (consultado 2026-09-30).
 * A chave vive no cofre (bearer_vault) e chega apenas ao transporte na hora do despacho;
 * destinatário, remetente, assunto e conteúdo integram a prévia exata que o usuário revisa.
 * Sem idempotência documentada e sem reconciliação de leitura: retryClass nunca automático.
 */
export const RESEND_DOCUMENTATION='https://resend.com/docs';
const origin='https://api.resend.com';
const hash=(value:unknown)=>createHash('sha256').update(canonicalStringify(value)).digest('hex');
const EMAIL_RE=/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
function text(value:unknown,name:string,max=1024){if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error(`productivity_${name}_invalid`);return value;}
function email(value:unknown,name:string){if(typeof value!=='string'||!EMAIL_RE.test(value)||value.length>200)throw new Error(`productivity_${name}_invalid`);return value;}
function contentText(value:unknown,name:string,max=65536){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))throw new Error(`productivity_${name}_invalid`);return value;}

export const RESEND_OPERATIONS:readonly ProductivityOperation[]=[{
  schemaVersion:1,id:'api.resend.send_email',serviceId:'resend',operationId:'send_email',method:'POST',path:'/emails',serverUrl:origin,
  summary:'Enviar correspondência revisável',schemaDigest:hash({operationId:'send_email',method:'POST',path:'/emails'}),documentDigest:hash(RESEND_DOCUMENTATION),
  effectClass:'escrita_externa',idempotencySupport:'none',reconciliationSupport:'none',requiredScopes:['run:execute','project:write'],authMethod:'bearer_vault',
  capability:parseCapabilityDescriptor({schemaVersion:1,id:'api.resend.send_email',createdAt:'2026-09-30T00:00:00.000Z',version:1,titleKey:'api.resend.send_email',descriptionKey:'api.resend.send_email',
   tags:['email','communication','resend'],inputSchemaId:'api.resend.send_email.input.v1',outputSchemaId:'api.resend.send_email.output.v1',effect:'write_external',
   dataDestination:{kind:'provider',id:'resend'},availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute','project:write'],retryClass:'never_automatic',
   limits:{maxSteps:1,maxCalls:1,maxOutputTokens:512,timeoutMs:15000,maxOutputBytes:131072}}),
}];

export function prepareResend(operationId:string,input:Record<string,unknown>):{operation:ProductivityOperation;prepared:PreparedProductivityCall;preview:EffectPreview|null}{
  if(operationId!=='send_email')throw new Error('productivity_operation_invalid');
  const operation=RESEND_OPERATIONS[0]!;
  const accountId=text(input.accountId,'account',128);if(!/^[A-Za-z0-9_-]+$/.test(accountId))throw new Error('productivity_account_invalid');
  if(Object.keys(input).some(key=>!['accountId','from','to','subject','text'].includes(key)))throw new Error('productivity_argument_invalid');
  const from=email(input.from,'from');
  if(typeof input.to!=='string')throw new Error('productivity_to_invalid');
  const recipients=input.to.split(',').map(item=>item.trim()).filter(Boolean);
  if(!recipients.length||recipients.length>10||recipients.some(item=>!EMAIL_RE.test(item)))throw new Error('productivity_to_invalid');
  const subject=text(input.subject,'subject',200);
  const body={from,to:recipients,subject,text:contentText(input.text,'text')};
  const base={schemaVersion:1 as const,serviceId:'resend',operationId,accountId,action:'send_email',object:recipients.join(', '),
    fields:{from,to:recipients.join(', '),subject,text:body.text},irreversibility:'irreversible_no_rollback' as const,cost:'unknown' as const};
  const preview={...base,previewDigest:hash(base)};
  const url=new URL('/emails',origin);
  const preparedBase={schemaVersion:1 as const,operationId,capabilityId:operation.id,serviceId:operation.serviceId,method:'POST' as const,url:url.href,origin,path:'/emails',query:{},body,accountId,previewDigest:preview.previewDigest,limits:{timeoutMs:15000,maxOutputBytes:131072}};
  return {operation,prepared:{...preparedBase,callDigest:hash(preparedBase)},preview};
}

export function verifyResend(prepared:PreparedProductivityCall):ProductivityOperation{
  if(prepared.operationId!=='send_email'||prepared.path!=='/emails'||prepared.method!=='POST'||prepared.origin!==origin)throw new Error('productivity_binding_changed');
  const body=prepared.body??{};
  const params:Record<string,unknown>={accountId:prepared.accountId,from:body.from,to:Array.isArray(body.to)?(body.to as string[]).join(','):body.to,subject:body.subject,text:body.text};
  const expected=prepareResend(prepared.operationId,params);
  if(canonicalStringify(prepared)!==canonicalStringify(expected.prepared))throw new Error('productivity_binding_changed');
  return expected.operation;
}
