// Adopt a confirmed native import through the original Workspace controllers.
// Native file copying is complete before this navigation-only adapter runs.
(function () {
  'use strict';
  const projectPath = /^\/workspace\/import-[a-f0-9]{32}$/;

  function connect(services, report) {
    let disposed = false, tail = Promise.resolve();
    const pending = new Map();
    const publish = result => {
      if (!disposed && typeof report === 'function') report(Object.freeze(result));
      return result;
    };
    function open(project) {
      if (disposed) return Promise.resolve({ ok: false, code: 'workspace_import_disposed' });
      if (typeof project !== 'string' || !projectPath.test(project)) {
        return Promise.resolve({ ok: false, code: 'workspace_import_path_invalid' });
      }
      const existing = pending.get(project);
      if (existing) return existing;
      const attempt = tail.then(async () => {
        if (disposed) return { ok: false, code: 'workspace_import_disposed' };
        try {
          const workspace = await services.createWorkspace({ path: project });
          if (disposed) return { ok: false, code: 'workspace_import_disposed' };
          const id = workspace?.workspaceId;
          if (typeof id !== 'string' || !id.length || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
            throw Error('workspace_import_response_invalid');
          }
          let selected = false;
          await services.openWorkspace(id, () => {
            // The canonical service calls beforeOpen only if no newer user
            // navigation superseded its connection. Disposal must not select.
            if (disposed) throw Error('workspace_import_disposed');
            selected = true;
          });
          if (disposed) return { ok: false, code: 'workspace_import_disposed' };
          if (!selected) return publish({ ok: false, project, code: 'workspace_import_navigation_superseded' });
          return publish({ ok: true, project, workspaceId: id });
        } catch {
          // Host errors can contain local paths; only a fixed code crosses the
          // feedback boundary. The original service retains its own notices.
          if (disposed) return { ok: false, code: 'workspace_import_disposed' };
          return publish({ ok: false, project, code: 'workspace_import_open_failed' });
        }
      });
      pending.set(project, attempt);
      const settled = () => { if (pending.get(project) === attempt) pending.delete(project); };
      tail = attempt.then(settled, settled);
      return attempt;
    }
    return Object.freeze({ open, dispose() { disposed = true; pending.clear(); } });
  }

  function apply(ctx) {
    if (window.UptokeyHarnessAccountReady !== true) return;
    ctx.inject(['workspaces', 'uiWorkspace'], scope => scope.effect(() => {
      const target = document.body;
      const bridge = connect({
        createWorkspace: input => scope.workspaces.create(input),
        openWorkspace: (id, beforeOpen) => scope.uiWorkspace.openWorkspace(id, beforeOpen),
      }, result => {
        if (result.ok) {
          target.dataset.uptokeyImportedProject = result.project;
          target.dataset.uptokeyImportedWorkspaceId = result.workspaceId;
        }
        window.dispatchEvent(new CustomEvent('uptokey:workspace-import-result', { detail: result }));
      });
      const imported = event => {
        const project = event.detail?.project;
        if (typeof project !== 'string' || !projectPath.test(project)) return;
        delete target.dataset.uptokeyImportedProject;
        delete target.dataset.uptokeyImportedWorkspaceId;
        void bridge.open(project);
      };
      const drain = () => {
        const queue = window.UptokeyHarnessWorkspaceImports;
        if (typeof queue?.take !== 'function') return;
        const projects = queue.take();
        if (!Array.isArray(projects)) return;
        for (const project of projects) imported({ detail: { project } });
      };
      window.addEventListener('uptokey:workspace-imported', imported);
      // Subscribe before reading: imports completed while Cordis dependencies
      // were pending stay queued, and later imports take the same route.
      window.addEventListener('uptokey:workspace-import-queued', drain);
      target.dataset.uptokeyWorkspaceImportReady = 'true';
      drain();
      return () => {
        window.removeEventListener('uptokey:workspace-imported', imported);
        window.removeEventListener('uptokey:workspace-import-queued', drain);
        bridge.dispose();
        delete target.dataset.uptokeyWorkspaceImportReady;
        delete target.dataset.uptokeyImportedProject;
        delete target.dataset.uptokeyImportedWorkspaceId;
      };
    }, 'uptokey: imported workspace navigation'));
  }
  window.UptokeyHarnessWorkspaceUI = Object.freeze({ apply, connect });
})();
