/**
 * Uptokey TUI — exact project/root association for the working folder.
 *
 * The folder is identified by the same root identity digest the core stores
 * (device, inode and creation time of the real path), never by its name and
 * never by "the first root of a project". Homonymous folders therefore stay
 * distinct, and several matching bindings are surfaced for an explicit choice.
 */
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { computeRootIdentityDigest } from "../workspace/project-root-service.ts";
import type { Project, RootBindingView, WorkspaceService } from "./workspace.ts";

export interface ProjectBinding {
  projectId: string;
  projectName: string;
  projectRevision: number;
  rootBindingId: string;
  rootPath: string;
  accessMode: "read_write" | "read_only";
  displayName: string;
}

export interface BindingCandidate {
  projectId: string;
  projectName: string;
  rootBindingId: string;
  accessMode: "read_write" | "read_only";
}

export type BindingOutcome =
  | { kind: "bound"; binding: ProjectBinding; created: boolean }
  | { kind: "ambiguous"; rootPath: string; candidates: BindingCandidate[] }
  | { kind: "error"; code: string; rootPath: string };

export function rootIdentityOf(path: string): { realPath: string; digest: string } {
  const realPath = realpathSync.native(resolve(path));
  return { realPath, digest: computeRootIdentityDigest(realPath) };
}

function usable(binding: RootBindingView, now: number): boolean {
  if (binding.revokedAt) return false;
  const expires = Date.parse(binding.expiresAt);
  return !Number.isFinite(expires) || expires > now;
}

/**
 * Resolves (or, with `create`, establishes) the binding for `rootPath`.
 * `projectHint` may be a project id: only that project is considered.
 * `preferred` selects among several matches (a remembered or explicit choice).
 */
export async function resolveProjectBinding(ws: WorkspaceService, input: {
  rootPath: string;
  projectHint?: string;
  preferred?: { projectId: string; rootBindingId: string };
  create?: boolean;
  now?: number;
  signal?: AbortSignal;
}): Promise<BindingOutcome> {
  let identity: { realPath: string; digest: string };
  try { identity = rootIdentityOf(input.rootPath); }
  catch { return { kind: "error", code: "project_root_not_found", rootPath: input.rootPath }; }
  const now = input.now ?? Date.now();
  let projects: Project[];
  try { projects = await ws.listAllProjects(input.signal); }
  catch (error) { return { kind: "error", code: error instanceof Error ? error.message : "projects_unavailable", rootPath: identity.realPath }; }
  const scope = input.projectHint ? projects.filter((p) => p.id === input.projectHint) : projects;
  if (input.projectHint && scope.length === 0) return { kind: "error", code: "project_not_found", rootPath: identity.realPath };
  const candidates: Array<BindingCandidate & { project: Project }> = [];
  for (const project of scope) {
    input.signal?.throwIfAborted();
    let roots: RootBindingView[];
    try { roots = await ws.listRootBindings(project.id, input.signal); }
    catch { continue; }
    for (const root of roots) {
      if (root.rootIdentityDigest === identity.digest && usable(root, now)) {
        candidates.push({ projectId: project.id, projectName: project.name, rootBindingId: root.id, accessMode: root.accessMode, project });
      }
    }
  }
  const pick = (candidate: BindingCandidate & { project: Project }): BindingOutcome => ({
    kind: "bound", created: false,
    binding: {
      projectId: candidate.projectId, projectName: candidate.projectName, projectRevision: Number(candidate.project.revision ?? 1),
      rootBindingId: candidate.rootBindingId, rootPath: identity.realPath, accessMode: candidate.accessMode, displayName: basename(identity.realPath),
    },
  });
  if (input.preferred) {
    const chosen = candidates.find((c) => c.projectId === input.preferred!.projectId && c.rootBindingId === input.preferred!.rootBindingId);
    if (chosen) return pick(chosen);
  }
  if (candidates.length === 1) return pick(candidates[0]!);
  if (candidates.length > 1) {
    return { kind: "ambiguous", rootPath: identity.realPath, candidates: candidates.map(({ project: _p, ...rest }) => rest) };
  }
  if (!input.create) return { kind: "error", code: "project_root_unbound", rootPath: identity.realPath };
  try {
    const project = input.projectHint ? scope[0]! : (
      input.preferred && scope.find(p => p.id === input.preferred!.projectId)
        ? scope.find(p => p.id === input.preferred!.projectId)!
        : await ws.createProject(basename(identity.realPath) || "projeto")
    );
    const root = await ws.registerRoot(project.id, identity.realPath);
    const bindings = await ws.listRootBindings(project.id, input.signal);
    const registered = bindings.find((b) => b.id === root.id);
    if (!registered || registered.rootIdentityDigest !== identity.digest) return { kind: "error", code: "project_root_identity_mismatch", rootPath: identity.realPath };
    const refreshed = await ws.refresh(project.id, input.signal).catch(() => null);
    return {
      kind: "bound", created: true,
      binding: {
        projectId: project.id, projectName: project.name, projectRevision: refreshed?.revision ?? Number(project.revision ?? 1),
        rootBindingId: registered.id, rootPath: identity.realPath, accessMode: registered.accessMode, displayName: basename(identity.realPath),
      },
    };
  } catch (error) {
    return { kind: "error", code: error instanceof Error ? error.message : "project_root_register_failed", rootPath: identity.realPath };
  }
}
