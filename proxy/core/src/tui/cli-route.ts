import { isAbsolute } from 'node:path';

const commands = new Set(['help','completion','version','proxy','start','doctor','providers','models','integrations','skills','mcp','tui','forge','code','update','security','provider','routing','license','quimera']);
const terminalOptions = new Set(['--cwd','--model','--connect','--lang','--resume','--screen-reader','--autonomy','--temporary','--external','--port','--theme','--next']);

/** Explicit terminal options and existing project folders cannot collide with administrative commands. */
export function routesToTerminal(first:string|undefined,isDirectory:(path:string)=>boolean):boolean {
  if (!first || commands.has(first)) return false;
  if (terminalOptions.has(first)) return true;
  if (first.startsWith('-')) return false;
  return isAbsolute(first) || first.startsWith('./') || first.startsWith('../') || first.startsWith('.\\') || first.startsWith('..\\') || isDirectory(first);
}
