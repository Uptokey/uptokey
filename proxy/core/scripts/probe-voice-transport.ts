/**
 * Opens the product's own OpenAI Realtime transport (the code the daemon runs) with a saved credential and reports
 * the WebSocket error/close detail; sends only the session.update, no audio, then closes.
 *   node scripts/probe-voice-transport.ts <model> <secretRef>
 */
import Ws from "ws";
import { OpenAIRealtimeTransport } from "../src/voice-realtime-transport.ts";
import { createOfficialSecretStore } from "../src/secret-store.ts";

const [model = "gpt-realtime-mini", ref = "provider:custom-openai"] = process.argv.slice(2);
const secrets = createOfficialSecretStore();
const transport = new OpenAIRealtimeTransport({
  model, profileRevision: 1,
  resolveCredential: async () => (await secrets.get(ref)) ?? undefined,
  connect: (url, options) => {
    const socket = new Ws(url, options);
    socket.on("unexpected-response", (_req, res) => { let body = ""; res.on("data", (c) => { body += c; }); res.on("end", () => console.log("unexpected-response", res.statusCode, body.slice(0, 300))); });
    socket.on("error", (error) => console.log("ws error:", error.message));
    socket.on("message", (data) => { const text = String(data); if (/"type":"(error|session\.(created|updated))"/.test(text)) console.log("event:", text.slice(0, 400)); });
    return socket as never;
  },
});
try {
  await transport.open({ profileRevision: 1, transport: "websocket", codec: "pcm16", sampleRate: 24000, maxDurationMs: 60000, allowedTools: [], turnPolicy: "push_to_talk" } as never, { onEvent() {}, onClose(reason) { console.log("closed:", reason); } });
  console.log("session opened");
} catch (error) { console.log("open failed:", (error as Error).message); }
await transport.close();
process.exit(0);
