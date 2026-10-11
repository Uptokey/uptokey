/**
 * J14 — the terminal's credential is disabled by the administrator while a proposed change waits for approval.
 * Approving afterwards must not write the file; the interface must report the refusal instead of a success.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const REVIEW = /Revisar alteração proposta|Review proposed change/;

async function admin(info, path, init = {}) {
  const response = await fetch(`${info.baseUrl}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${info.admin}`, ...(init.headers ?? {}) } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

export async function revokeJourney({ term, checks, capture, info }) {
  const file = join(info.cwd, "math.js");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("CORRIJA_SOMA");
  await term.send(ENTER);
  await term.until(() => REVIEW.test(term.screen()), "review prompt did not appear", 40000);
  capture("1. revisão aberta");
  const listed = await admin(info, "/local/client-keys?limit=50");
  checks.listStatus = listed.status;
  checks.listSample = JSON.stringify(listed.body).slice(0, 1200);
  const keys = listed.body?.keys ?? listed.body?.items ?? listed.body ?? [];
  // The listing masks the secret as "<prefix>…<suffix>"; the terminal's own token identifies its entry.
  // The fixture profile holds only the terminal's paired credential (the admin token is not a client key); it is the
  // entry that was used by the turn above.
  const used = (Array.isArray(keys) ? keys : []).filter((entry) => entry.lastUsedAt && entry.enabled && !entry.revokedAt);
  const key = used.length === 1 ? used[0] : undefined;
  assert.ok(key, `the terminal's credential was not found in the key list (status ${listed.status})`);
  const patched = await admin(info, `/local/client-keys/${encodeURIComponent(key.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ expectedRevision: key.revision, operationId: randomUUID(), enabled: false }),
  });
  checks.disableStatus = patched.status;
  assert.equal(patched.status, 200, `disabling the credential failed: ${JSON.stringify(patched.body)}`);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 5000));
  const after = await readFile(file, "utf8");
  assert.match(after, /a - b/, "the change was written after the credential was disabled");
  checks.nothingWritten = true;
  const screen = term.screen();
  checks.screenAfterApproval = screen.split("\n").filter((line) => line.trim()).slice(-12).join("\n");
  assert.ok(!/Aplicad|applied|recibo [0-9a-f-]{8}/i.test(screen), "the interface reported a success");
  checks.noSuccessReported = true;
  capture("2. aprovação após revogação");
}
