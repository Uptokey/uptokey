/**
 * Opens the OpenAI Realtime WebSocket handshake with the saved key (never printed) and reports the HTTP outcome and the
 * provider's error message; closes immediately (no audio, no usage).
 *   node scripts/probe-openai-realtime.ts <model> [secretRef]
 */
import { request } from "node:https";
import { randomBytes } from "node:crypto";
import { createOfficialSecretStore } from "../src/secret-store.ts";

const model = process.argv[2] ?? "gpt-realtime-mini";
const ref = process.argv[3] ?? "provider:custom-openai";
const secret = await createOfficialSecretStore().get(ref);
if (!secret) { console.log(`no secret at ${ref}`); process.exit(0); }
await new Promise<void>((done) => {
  const req = request({
    host: "api.openai.com", path: `/v1/realtime?model=${encodeURIComponent(model)}`, method: "GET",
    headers: { authorization: `Bearer ${secret}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64") },
  });
  req.on("upgrade", (response, socket) => { console.log(model, "upgrade", response.statusCode, "(handshake accepted)"); socket.destroy(); done(); });
  req.on("response", (response) => {
    let body = "";
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => { console.log(model, "status", response.statusCode, (/"message":\s*"([^"]*)"/.exec(body)?.[1] ?? body.slice(0, 160)).split(secret).join("[redacted]")); done(); });
  });
  req.on("error", (error) => { console.log(model, "error", error.message); done(); });
  req.end();
});
