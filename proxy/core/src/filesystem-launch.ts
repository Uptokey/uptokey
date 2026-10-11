import { dirname, isAbsolute, join } from 'node:path';
import { FilesystemMcpService, filesystemDiagnostic } from './filesystem-mcp-service.ts';
import type { WorkspaceServices } from './workspace/runtime.ts';
import { developmentProductRoot, productCodeRoots } from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";

/** Opt-in starts discovery only; every read still needs its own W0 approval. */
export function filesystemStartOption(args: readonly string[]): string | undefined {
  const options=args.filter(value=>value.startsWith('--filesystem'));
  if(!options.length)return undefined;
  const offset=args[0]==='start'?1:args[0]==='proxy'&&args[1]==='start'?2:0;
  if(!offset||options.length!==1||!options[0]!.startsWith('--filesystem-root='))throw new Error('quimera_filesystem_option_rejected');
  const root=options[0]!.slice('--filesystem-root='.length);
  if(!isAbsolute(root)||root.includes('\0')||root.length>2048)throw new Error('quimera_filesystem_option_rejected');
  return root;
}

/**
 * A failed discovery keeps the daemon and its history usable: the profile is reported as
 * unavailable with a fixed diagnostic code instead of a path or upstream message.
 */
export async function createFilesystemProfile(allowedRoot:string, quimeraRoot?:string,
  packageRoot?:string):Promise<NonNullable<WorkspaceServices['filesystem']>> {
  try {
    const stateParent=quimeraRoot ?? dirname(developmentProductRoot(import.meta.url));
    const integrations=quimeraRoot ? join(quimeraRoot,'integrations') : productCodeRoots().INTEGRATIONS;
    const service=new FilesystemMcpService({packageRoot:packageRoot ?? join(integrations,'mcp-filesystem/node_modules/@modelcontextprotocol/server-filesystem'),allowedRoot,stateRoot:join(stateParent,'output/filesystem-runtime')});
    const catalog=await service.discover(new AbortController().signal,new Date(Date.now()+15_000).toISOString());
    return {service,...catalog};
  } catch(error) {
    return {available:false,diagnostic:filesystemDiagnostic(error)};
  }
}
