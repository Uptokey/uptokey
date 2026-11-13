import {createScopedMcpHost} from '../scoped-mcp-host.ts';
import {createProjectTaskMcpServer, type ProjectTaskMcpBinding} from './project-task-mcp.ts';
import type {WorkspaceRuntime} from './runtime.ts';

/** Immutable task binding over the shared host-owned MCP transport. */
export function createProjectTaskMcpHost(
  runtime: WorkspaceRuntime,
  binding: Readonly<ProjectTaskMcpBinding>,
  options: {authorize: () => Promise<boolean>},
) {
  const scope = Object.freeze({...binding});
  return createScopedMcpHost(
    authorize => createProjectTaskMcpServer(runtime, scope, {authorize}), options,
  );
}
