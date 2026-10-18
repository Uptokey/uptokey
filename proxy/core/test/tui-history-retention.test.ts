import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TuiClient } from "../src/tui/client.ts";
import { ConversationService, type ThreadMessage } from "../src/tui/conversations.ts";

/** Inspect strong data references, without depending on cache names or GC timing. */
function retainedObjects(root: object, targets: ReadonlySet<object>): number {
  const seen = new Set<object>(), retained = new Set<object>(), pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (targets.has(value)) retained.add(value);
    if (value instanceof Map) { for (const [key, item] of value) pending.push(key, item); }
    else if (value instanceof Set) pending.push(...value);
    else for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) pending.push(descriptor.value);
    }
  }
  return retained.size;
}

test("visiting twelve large histories releases service display bodies and reopens current canonical data", async t => {
  const client = new TuiClient({ baseUrl: "http://127.0.0.1:21435" });
  t.after(() => client.destroy());
  const service = new ConversationService(client), ids = Array.from({ length: 12 }, () => randomUUID());
  const messageIds = Array.from({ length: 20 }, () => randomUUID()), first = messageIds[0]!, last = messageIds.at(-1)!;
  let active = ids[0]!, revision = 1, reads = 0;
  t.mock.method(service, "getConversation", async (id: string) => ({ id, activeBranchId: "main" } as never));
  t.mock.method(client, "getMessages", async (id: string) => {
    assert.equal(id, active); reads++;
    return messageIds.map((messageId, index): ThreadMessage => ({
      schemaVersion: 1, id: messageId, conversationId: id, parentId: messageIds[index - 1] ?? null,
      branchId: "main", role: index ? "assistant" : "user", clientMessageId: randomUUID(),
      createdAt: "2026-10-18T00:00:00.000Z", revision,
      parts: [{ id: randomUUID(), messageId, type: "text", text: `${id}:${revision}:${index}:` + String(index % 10).repeat(50_000) }],
    }));
  });
  const oldViews = new Set<object>();
  for (const id of ids) {
    active = id;
    const view = await service.loadMessages(id);
    assert.equal(view.length, 20);
    assert.ok(view.reduce((size, row) => size + row.content.length, 0) > 1_000_000);
    oldViews.add(view); for (const row of view) oldViews.add(row);
  }
  assert.equal(retainedObjects(service, oldViews), 0, "the service must not keep inactive display arrays or message bodies");
  assert.equal(reads, 12);
  active = ids[0]!; revision = 2;
  const reopened = await service.loadMessages(active);
  assert.equal(reads, 13, "reopening rehydrates through the canonical core");
  assert.equal(reopened[0]!.id, first); assert.equal(reopened.at(-1)!.id, last);
  assert.ok(reopened.every(row => row.content.startsWith(`${active}:2:`)), "first and last complete bodies use current data");
  assert.ok(reopened.every(row => row.content.length > 50_000), "no truncation to achieve retention limits");
  const page = await service.loadMessages(active, first);
  assert.equal(page.length, 19); assert.equal(page[0]!.id, messageIds[1]); assert.equal(page.at(-1)!.id, last);
  assert.equal(page.at(-1)!.content, reopened.at(-1)!.content, "message anchor and complete body survive rehydration");
  await assert.rejects(service.loadMessages(active, randomUUID()), /message_not_found/);
});
