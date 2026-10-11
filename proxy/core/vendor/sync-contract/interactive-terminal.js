import { isDataRecord } from './plain-data.js';

export const TERMINAL_LIMITS = Object.freeze({ inputBytes: 32768, outputBytes: 1048576, outputEvents: 2048, pageBytes: 65536, columns: 500, rows: 200, activePerOwner: 8, activeTotal: 32, retainedPerOwner: 32, retainedTotal: 128, pollMs: 20000 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
export class TerminalContractError extends Error { constructor() { super('terminal_request_invalid'); } }
const fail = () => { throw new TerminalContractError(); };
function fields(value, required, optional = []) {
  if (!isDataRecord(value) || required.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return value;
}
function dimensions(value) {
  if (!Number.isInteger(value.cols) || value.cols < 2 || value.cols > TERMINAL_LIMITS.columns || !Number.isInteger(value.rows) || value.rows < 1 || value.rows > TERMINAL_LIMITS.rows) fail();
  return {cols:value.cols,rows:value.rows};
}
export function parseTerminalCreate(value) {
  fields(value,['requestId','rootBindingId','cols','rows'],['shell']);
  if (typeof value.requestId !== 'string' || !uuid.test(value.requestId) || typeof value.rootBindingId !== 'string' || !id.test(value.rootBindingId) || value.shell !== undefined && !['default','powershell','cmd','bash','zsh'].includes(value.shell)) fail();
  return {requestId:value.requestId,rootBindingId:value.rootBindingId,...dimensions(value),shell:value.shell ?? 'default'};
}
export function parseTerminalInput(value) {
  fields(value,['sequence','data']);
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || typeof value.data !== 'string' || !value.data.length || new TextEncoder().encode(value.data).length > TERMINAL_LIMITS.inputBytes) fail();
  return {sequence:value.sequence,data:value.data};
}
export function parseTerminalResize(value) { fields(value,['cols','rows']); return dimensions(value); }
export function parseTerminalClose(value) { fields(value,[]); return {}; }
export function parseTerminalSession(value) {
  fields(value,['id','projectId','rootBindingId','title','shell','cols','rows','state','exitCode','createdAt','closedAt','acceptedSequence']);
  if (![value.id,value.projectId,value.rootBindingId].every(v=>typeof v==='string'&&id.test(v)) || typeof value.title!=='string' || value.title.length>80 || !['default','powershell','cmd','bash','zsh'].includes(value.shell) || !['running','closing','exited'].includes(value.state) || !(value.exitCode===null||Number.isSafeInteger(value.exitCode)) || !Number.isSafeInteger(value.acceptedSequence)||value.acceptedSequence<0 || typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt)) || !(value.closedAt===null||typeof value.closedAt==='string'&&Number.isFinite(Date.parse(value.closedAt)))) fail();
  dimensions(value);return {...value};
}
export function parseTerminalList(value) {
  fields(value,['sessions','shells']);if(!Array.isArray(value.sessions)||value.sessions.length>TERMINAL_LIMITS.retainedPerOwner||!Array.isArray(value.shells)||value.shells.length>5||new Set(value.shells).size!==value.shells.length||value.shells.some(shell=>!['default','powershell','cmd','bash','zsh'].includes(shell)))fail();
  return {sessions:value.sessions.map(parseTerminalSession),shells:[...value.shells]};
}
export function parseTerminalPage(value) {
  fields(value,['session','events','nextCursor','oldestCursor','truncated']);
  if(!Array.isArray(value.events)||value.events.length>TERMINAL_LIMITS.outputEvents||![value.nextCursor,value.oldestCursor].every(v=>Number.isSafeInteger(v)&&v>=0)||typeof value.truncated!=='boolean')fail();
  let previous=0,bytes=0;
  const events=value.events.map(event=>{fields(event,['sequence','data']);if(!Number.isSafeInteger(event.sequence)||event.sequence<=previous||typeof event.data!=='string')fail();previous=event.sequence;bytes+=new TextEncoder().encode(event.data).length;return {...event};});
  if(bytes>TERMINAL_LIMITS.pageBytes||events.length&&events.at(-1).sequence!==value.nextCursor)fail();
  return {session:parseTerminalSession(value.session),events,nextCursor:value.nextCursor,oldestCursor:value.oldestCursor,truncated:value.truncated};
}
