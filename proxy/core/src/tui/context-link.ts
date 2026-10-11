import { readBoundedJson } from '@uptokey/sync-contract/limits';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type ContextLinkDependencies = {
  conversationId: string;
  projectId: string;
  assertCurrent(): void;
  conversation(): Promise<{ id: string; projectId: string | null; revision: number }>;
  approve(body: { id: string; userCode: string; conversationId: string; expectedRevision: number }): Promise<Response>;
};

/** The owner explicitly links the active project; approval never follows a later UI selection. */
export async function approveActiveContext(input: string, dependencies: ContextLinkDependencies): Promise<void> {
  const [id, userCode, extra] = input.trim().split(/\s+/);
  if (!id || !UUID.test(id) || !userCode || !/^[a-f0-9]{8}$/i.test(userCode) || extra !== undefined) throw new Error('context_link_usage');
  dependencies.assertCurrent();
  const current = await dependencies.conversation();
  dependencies.assertCurrent();
  if (current.id !== dependencies.conversationId || current.projectId !== dependencies.projectId || !Number.isSafeInteger(current.revision) || current.revision < 1) throw new Error('context_link_context_changed');
  const response = await dependencies.approve({ id, userCode, conversationId: current.id, expectedRevision: current.revision });
  const result = await readBoundedJson(response, 4_096);
  dependencies.assertCurrent();
  if (!response.ok || !result.ok || !result.value || typeof result.value !== 'object' || (result.value as Record<string, unknown>).approved !== true) {
    throw new Error(response.status === 409 ? 'context_link_conflict' : response.status === 410 || response.status === 404 ? 'context_link_expired' : 'context_link_failed');
  }
}
