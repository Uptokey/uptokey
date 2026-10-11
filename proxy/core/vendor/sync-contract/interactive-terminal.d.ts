export type TerminalShell = 'default' | 'powershell' | 'cmd' | 'bash' | 'zsh';
export interface TerminalCreate { requestId:string;rootBindingId:string;cols:number;rows:number;shell:TerminalShell }
export interface TerminalInput { sequence:number;data:string }
export interface TerminalSize { cols:number;rows:number }
export interface TerminalSession extends TerminalSize {
  id:string;projectId:string;rootBindingId:string;title:string;shell:TerminalShell;state:'running'|'closing'|'exited';
  exitCode:number|null;createdAt:string;closedAt:string|null;acceptedSequence:number;
}
export interface TerminalEvent { sequence:number;data:string }
export interface TerminalPage { session:TerminalSession;events:TerminalEvent[];nextCursor:number;oldestCursor:number;truncated:boolean }
export const TERMINAL_LIMITS: Readonly<{inputBytes:number;outputBytes:number;outputEvents:number;pageBytes:number;columns:number;rows:number;activePerOwner:number;activeTotal:number;retainedPerOwner:number;retainedTotal:number;pollMs:number}>;
export class TerminalContractError extends Error {}
export function parseTerminalCreate(value:unknown):TerminalCreate;
export function parseTerminalInput(value:unknown):TerminalInput;
export function parseTerminalResize(value:unknown):TerminalSize;
export function parseTerminalClose(value:unknown):Record<string,never>;
export function parseTerminalSession(value:unknown):TerminalSession;
export function parseTerminalList(value:unknown):{sessions:TerminalSession[];shells:TerminalShell[]};
export function parseTerminalPage(value:unknown):TerminalPage;
