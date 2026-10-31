import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isSafeRelativePath,
  parseProjectRootBinding,
  parseProjectTaskSpec,
  computeProjectTaskSpecDigest,
  parseProjectFileManifest,
  parseProjectChangeSet,
  computeProjectChangeSetDigest,
  parseProjectRunRequest,
  parseProjectTask,
  parseProjectVerificationReport,
  parseProjectPreviewSession, computeTreeDigest, extractSymbolOutline,
  parseRunAuthority
} from '../project-agent.js';

test('project changeset accepts UTF-8 content in browsers without Node Buffer', () => {
  const originalBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const raw = {id:'restore-browser',taskId:'restore-task',revision:1,baseManifestDigest:'a'.repeat(64),
      operations:[{type:'replace',path:'README.md',expectedSha256:'b'.repeat(64),newSha256:'c'.repeat(64),content:'Restauração: ação 🧪'}]};
    assert.equal(parseProjectChangeSet({...raw,digest:computeProjectChangeSetDigest(raw)}).operations[0].content,raw.operations[0].content);
  } finally { globalThis.Buffer = originalBuffer; }
});

test('isSafeRelativePath: accepts safe relative paths and rejects traversals, absolute, ADS, device names', () => {
  assert.equal(isSafeRelativePath('docs/README.md'), true);
  assert.equal(isSafeRelativePath('web/index.html'), true);
  assert.equal(isSafeRelativePath('src/deep/nested/file.ts'), true);

  // Traversals
  assert.equal(isSafeRelativePath('../README.md'), false);
  assert.equal(isSafeRelativePath('docs/../../etc/passwd'), false);
  assert.equal(isSafeRelativePath('./foo'), false);
  assert.equal(isSafeRelativePath(''), false);

  // Absolute & Windows drive
  assert.equal(isSafeRelativePath('/etc/passwd'), false);
  assert.equal(isSafeRelativePath('\\\\Windows\\\\System32'), false);
  assert.equal(isSafeRelativePath('C:\\foo\\bar'), false);
  assert.equal(isSafeRelativePath('c:/foo/bar'), false);

  // ADS & reserved characters
  assert.equal(isSafeRelativePath('foo:stream'), false);
  assert.equal(isSafeRelativePath('foo?bar'), false);
  assert.equal(isSafeRelativePath('foo*bar'), false);
  assert.equal(isSafeRelativePath('foo<bar'), false);

  // Windows device names
  assert.equal(isSafeRelativePath('CON'), false);
  assert.equal(isSafeRelativePath('con.txt'), false);
  assert.equal(isSafeRelativePath('sub/PRN/file.txt'), false);
  assert.equal(isSafeRelativePath('AUX'), false);
  assert.equal(isSafeRelativePath('NUL'), false);
  assert.equal(isSafeRelativePath('COM1'), false);
  assert.equal(isSafeRelativePath('LPT1'), false);

  // Trailing dot or space
  assert.equal(isSafeRelativePath('foo. '), false);
  assert.equal(isSafeRelativePath('foo.'), false);
  assert.equal(isSafeRelativePath('dir /file'), false);
});

test('parseProjectRootBinding: strictly validates binding fields, dates and accessMode', () => {
  const valid = {
    id: 'root-1',
    projectId: 'proj-1',
    principalId: 'user-1',
    revision: 1,
    displayName: 'My Safe Project',
    rootIdentityDigest: 'a'.repeat(64),
    grantedAt: '2026-09-19T12:00:00.000Z',
    expiresAt: '2026-09-19T13:00:00.000Z',
    accessMode: 'read_write'
  };

  const parsed = parseProjectRootBinding(valid);
  assert.equal(parsed.id, 'root-1');
  assert.equal(parsed.accessMode, 'read_write');
  assert.equal(Object.isFrozen(parsed), true);

  // Rejects inverted dates
  assert.throws(() => parseProjectRootBinding({
    ...valid,
    expiresAt: '2026-09-19T11:00:00.000Z'
  }), /project_root_binding_invalid/);

  // Rejects invalid accessMode
  assert.throws(() => parseProjectRootBinding({
    ...valid,
    accessMode: 'admin_root'
  }), /project_root_binding_invalid/);

  // Rejects extra property
  assert.throws(() => parseProjectRootBinding({
    ...valid,
    extra: 'hack'
  }), /project_root_binding_invalid/);
});

test('parseProjectTaskSpec: binds all material fields, limits and computed digest', () => {
  const rawSpec = {
    schemaVersion: 1,
    id: 'task-spec-1',
    projectId: 'proj-1',
    rootBindingId: 'root-1',
    rootBindingRevision: 1,
    rootIdentityDigest: 'b'.repeat(64),
    objective: 'Create documentation and index.html',
    mode: 'bounded',
    allowedCapabilityIds: ['project.files.write', 'project.runtime.check'],
    allowedDestinations: ['docs/README.md', 'web/index.html'],
    runtimeProfileIds: ['static-web'],
    filePolicy: {
      allowedExtensions: ['.md', '.html', '.css', '.js'],
      excludedPaths: ['.git', 'node_modules'],
      allowHidden: false
    },
    networkPolicy: 'none',
    installPolicy: 'none',
    limits: {
      maxIterations: 3,
      maxInferenceCalls: 12,
      maxAggregateOutputTokens: 24000,
      timeoutMs: 1800000,
      maxFiles: 100,
      maxFileSizeBytes: 1048576,
      maxTotalChangeBytes: 20971520
    },
    acceptanceSpecRef: '19-aceite.json'
  };

  const digest = computeProjectTaskSpecDigest(rawSpec);
  const spec = parseProjectTaskSpec({ ...rawSpec, digest });
  assert.equal(spec.digest, digest);
  assert.equal(spec.limits.maxIterations, 3);
  assert.equal(Object.isFrozen(spec.limits), true);

  // Rejects tampered digest
  assert.throws(() => parseProjectTaskSpec({ ...rawSpec, digest: 'c'.repeat(64) }), /project_task_spec_invalid/);

  // Rejects out-of-bound limits
  assert.throws(() => parseProjectTaskSpec({
    ...rawSpec,
    limits: { ...rawSpec.limits, maxIterations: 999 },
    digest
  }), /project_task_spec_invalid/);
});

test('parseProjectFileManifest: validates entries, sensitivity and safe relative paths', () => {
  const manifest = {
    id: 'manifest-1',
    projectId: 'proj-1',
    rootBindingId: 'root-1',
    snapshotDigest: 'd'.repeat(64),
    entries: [
      {
        relativePath: 'docs/README.md',
        kind: 'file',
        language: 'markdown',
        mediaType: 'text/markdown',
        byteLength: 256,
        sha256: 'e'.repeat(64),
        sensitivity: 'public'
      },
      {
        relativePath: 'web/index.html',
        kind: 'file',
        language: 'html',
        mediaType: 'text/html',
        byteLength: 512,
        sha256: 'f'.repeat(64),
        sensitivity: 'public'
      }
    ]
  };

  const parsed = parseProjectFileManifest(manifest);
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.entries[0].relativePath, 'docs/README.md');

  // Rejects duplicate paths
  assert.throws(() => parseProjectFileManifest({
    ...manifest,
    entries: [manifest.entries[0], manifest.entries[0]]
  }), /project_file_manifest_invalid/);

  // Rejects traversal path in manifest
  assert.throws(() => parseProjectFileManifest({
    ...manifest,
    entries: [{
      relativePath: '../secret.txt',
      kind: 'file',
      byteLength: 10,
      sha256: 'a'.repeat(64)
    }]
  }), /project_file_manifest_invalid/);
});

test('parseProjectChangeSet: verifies operations, digest and atomic requirements', () => {
  const rawChangeSet = {
    id: 'changeset-1',
    taskId: 'task-1',
    baseManifestDigest: '1'.repeat(64),
    revision: 1,
    operations: [
      {
        type: 'mkdir',
        path: 'docs'
      },
      {
        type: 'create',
        path: 'docs/README.md',
        newSha256: '2'.repeat(64),
        content: '# Project Documentation\\n\\nCreated by Uptokey Project Agent.'
      },
      {
        type: 'mkdir',
        path: 'web'
      },
      {
        type: 'create',
        path: 'web/index.html',
        newSha256: '3'.repeat(64),
        content: '<!DOCTYPE html><html><body><h1>Hello World</h1></body></html>'
      }
    ]
  };

  const digest = computeProjectChangeSetDigest(rawChangeSet);
  const cs = parseProjectChangeSet({ ...rawChangeSet, digest });
  assert.equal(cs.operations.length, 4);
  assert.equal(cs.operations[1].type, 'create');

  // Rejects replace operation without expectedSha256
  const badReplace = {
    ...rawChangeSet,
    operations: [{
      type: 'replace',
      path: 'docs/README.md',
      newSha256: '4'.repeat(64)
    }]
  };
  const badDigest = computeProjectChangeSetDigest(badReplace);
  assert.throws(() => parseProjectChangeSet({ ...badReplace, digest: badDigest }), /project_change_set_invalid/);
});

test('parseRunAuthority: strictly discriminates plan_approval vs project_task_delegation', () => {
  const approval = parseRunAuthority({
    kind: 'plan_approval',
    approvalId: 'appr-123'
  });
  assert.equal(approval.kind, 'plan_approval');
  assert.equal(approval.approvalId, 'appr-123');

  const delegation = parseRunAuthority({
    kind: 'project_task_delegation',
    taskId: 'task-456',
    rootRunId: 'run-root-789',
    specDigest: 'a'.repeat(64),
    childPlanDigest: 'b'.repeat(64),
    reservationId: 'res-1',
    iteration: 1
  });
  assert.equal(delegation.kind, 'project_task_delegation');
  assert.equal(delegation.taskId, 'task-456');

  // Rejects unknown kind
  assert.throws(() => parseRunAuthority({
    kind: 'auto_approval',
    approvalId: 'appr-123'
  }), /run_authority_invalid/);

  // Rejects delegation missing reservationId
  assert.throws(() => parseRunAuthority({
    kind: 'project_task_delegation',
    taskId: 'task-456',
    rootRunId: 'run-root-789',
    specDigest: 'a'.repeat(64),
    childPlanDigest: 'b'.repeat(64),
    iteration: 1
  }), /run_authority_invalid/);
});

test('parseProjectVerificationReport & parseProjectPreviewSession: validation and immutability', () => {
  const report = parseProjectVerificationReport({
    taskId: 'task-1',
    runId: 'run-1',
    manifestDigest: '5'.repeat(64),
    runtimeFingerprint: 'node:22.0.0-linux-x64-isolated',
    checks: [
      {
        id: 'AC-19-04',
        method: 'file_exists',
        expected: 'file exists and sha256 matches',
        observed: 'file verified',
        artifactRefs: ['art-1'],
        status: 'pass'
      }
    ]
  });
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].status, 'pass');

  const session = parseProjectPreviewSession({
    id: 'preview-1',
    taskId: 'task-1',
    manifestDigest: '6'.repeat(64),
    runtimeJobRef: null,
    origin: 'http://127.0.0.1:45123',
    allowedResourceIds: ['docs/README.md', 'web/index.html'],
    expiresAt: '2026-09-19T13:30:00.000Z',
    status: 'running'
  });
  assert.equal(session.origin, 'http://127.0.0.1:45123');
  assert.equal(session.status, 'running');
});

test('project-agent: efficiency extensions (patch_lines, computeTreeDigest, extractSymbolOutline)', () => {
  // 1. Valid patch_lines operation in ChangeSet
  const cs = {
    id: 'cs-patch-1',
    taskId: 'task-1',
    baseManifestDigest: '1'.repeat(64),
    revision: 1,
    operations: [
      {
        type: 'patch_lines',
        path: 'docs/README.md',
        expectedSha256: '2'.repeat(64),
        patches: [
          {
            startLine: 5,
            deleteCount: 2,
            newLines: ['# Line 5 modified', '# Line 6 inserted']
          }
        ]
      }
    ]
  };
  const csDigest = computeProjectChangeSetDigest(cs);
  const parsedCs = parseProjectChangeSet({ ...cs, digest: csDigest });
  assert.equal(parsedCs.operations[0].type, 'patch_lines');
  assert.equal(parsedCs.operations[0].patches[0].startLine, 5);
  assert.equal(parsedCs.operations[0].patches[0].deleteCount, 2);
  assert.deepEqual(parsedCs.operations[0].patches[0].newLines, ['# Line 5 modified', '# Line 6 inserted']);

  // Invalid patch_lines missing expectedSha256
  assert.throws(() => {
    parseProjectChangeSet({
      ...cs,
      operations: [{ type: 'patch_lines', path: 'docs/README.md', patches: [] }],
      digest: csDigest
    });
  });

  // Invalid patch_lines negative startLine
  assert.throws(() => {
    parseProjectChangeSet({
      ...cs,
      operations: [{
        type: 'patch_lines',
        path: 'docs/README.md',
        expectedSha256: '2'.repeat(64),
        patches: [{ startLine: 0, deleteCount: 0, newLines: [] }]
      }],
      digest: csDigest
    });
  });

  // 2. computeTreeDigest
  const tree1 = computeTreeDigest([
    { path: 'web/index.html', sha256: 'a'.repeat(64), size: 100 },
    { path: 'docs/README.md', sha256: 'b'.repeat(64), size: 200 }
  ]);
  const tree2 = computeTreeDigest([
    { path: 'docs/README.md', sha256: 'b'.repeat(64), size: 200 },
    { path: 'web/index.html', sha256: 'a'.repeat(64), size: 100 }
  ]);
  assert.equal(tree1.rootDigest, tree2.rootDigest, 'TreeDigest must be order-independent');
  assert.equal(tree1.entries[0].path, 'docs/README.md', 'TreeDigest entries must be sorted');

  // 3. extractSymbolOutline
  const jsCode = `
export function calculateTotal(items) { return 0; }
export class OrderManager {}
export interface OrderItem {}
export const DEFAULT_TAX = 0.05;
`;
  const outline = extractSymbolOutline('src/order.ts', jsCode);
  assert.equal(outline.path, 'src/order.ts');
  assert.equal(outline.symbols.length, 4);
  assert.equal(outline.symbols[0].name, 'calculateTotal');
  assert.equal(outline.symbols[0].kind, 'function');
  assert.equal(outline.symbols[1].name, 'OrderManager');
  assert.equal(outline.symbols[1].kind, 'class');
  assert.equal(outline.symbols[2].name, 'OrderItem');
  assert.equal(outline.symbols[2].kind, 'interface');
  assert.equal(outline.symbols[3].name, 'DEFAULT_TAX');
  assert.equal(outline.symbols[3].kind, 'export');
});

test('project changeset delete is bound to exact bytes and carries no content', () => {
  const base = { id: 'cs-del-1', taskId: 'task-1', baseManifestDigest: '1'.repeat(64), revision: 1 };
  const valid = { ...base, operations: [{ type: 'delete', path: 'src/a.ts', expectedSha256: '2'.repeat(64) }] };
  const parsed = parseProjectChangeSet({ ...valid, digest: computeProjectChangeSetDigest(valid) });
  assert.equal(parsed.operations[0].type, 'delete');
  assert.equal(parsed.operations[0].expectedSha256, '2'.repeat(64));
  for (const op of [
    { type: 'delete', path: 'src/a.ts' },
    { type: 'delete', path: 'src/a.ts', expectedSha256: '2'.repeat(64), content: '' },
    { type: 'delete', path: 'src/a.ts', expectedSha256: '2'.repeat(64), newSha256: '3'.repeat(64) },
    { type: 'delete', path: 'src/a.ts', expectedSha256: '2'.repeat(64), fromPath: 'src/b.ts' },
    { type: 'delete', path: '../escape.ts', expectedSha256: '2'.repeat(64) },
  ]) {
    const input = { ...base, operations: [op] };
    assert.throws(() => parseProjectChangeSet({ ...input, digest: computeProjectChangeSetDigest(input) }), /project_change_set_invalid/);
  }
});
