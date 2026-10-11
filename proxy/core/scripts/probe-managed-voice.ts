/**
 * Runs the daemon's managed voice path (saved voice profile → connection profile → vault credential → realtime
 * transport) against the person's profile and logs the WebSocket outcome; opens no microphone and sends no audio.
 *   UPTOKEY_QUIMERA_DATA_DIR=<profile> node scripts/probe-managed-voice.ts
 */
import Ws from "ws";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOfficialSecretStore } from "../src/secret-store.ts";
import { ConnectionProfileService, fileConnectionStorage } from "../src/connection-profiles.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { createManagedVoice } from "../src/voice-profile.ts";

const secrets = createOfficialSecretStore();
const profiles = new ConnectionProfileService(secrets, fileConnectionStorage());
const store = new WorkspaceStore(secrets, await mkdtemp(join(tmpdir(), "voice-probe-")));
const voice = createManagedVoice(store, secrets, () => profiles, {
  connect: (url, options) => {
    const socket = new Ws(url, options);
    socket.on("unexpected-response", (_req, res) => console.log("unexpected-response", res.statusCode));
    socket.on("error", (error) => console.log("ws error:", error.message));
    socket.on("message", (data) => { const text = String(data); const type = /"type":"([^"]+)"/.exec(text)?.[1]; if (type === "error") console.log("provider error:", (/"code":"([^"]+)"/.exec(text) ?? [])[1]); else if (type) console.log("event:", type); });
    return socket as never;
  },
});
const profile = await voice.supervisor.profile();
console.log("profile:", JSON.stringify({ configured: profile.configured, model: profile.model, budgetRequired: (profile as { budgetRequired?: boolean }).budgetRequired, budgetReason: (profile as { budgetReason?: string }).budgetReason }));
const transport = (voice.supervisor as unknown as { transports: { create(revision: number, authority?: unknown): { open(session: unknown, handlers: unknown): Promise<void>; close(): Promise<void> } } }).transports?.create(profile.profileRevision);
if (!transport) { console.log("transport factory not reachable from the probe"); process.exit(0); }
try {
  await transport.open({ profileRevision: profile.profileRevision, transport: "websocket", codec: "pcm16", sampleRate: 24000, maxDurationMs: 60000, allowedTools: [], turnPolicy: "push_to_talk" }, { onEvent() {}, onClose(reason: string) { console.log("closed:", reason); } });
  console.log("session opened");
} catch (error) { console.log("open failed:", (error as Error).message); }
await transport.close();
await voice.supervisor.close();
await store.close();
process.exit(0);
