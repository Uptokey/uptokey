/**
 * Diagnoses a rejected OpenAI chat request with the saved provider key (never printed): a minimal call, then the
 * same call with the parameters the core may add, reporting each HTTP status and the provider's error message.
 *   node scripts/probe-openai-chat.ts [model]
 */
import { createOfficialSecretStore } from "../src/secret-store.ts";

const model = process.argv[2] ?? "gpt-5-mini";
const secret = await createOfficialSecretStore().get("provider:custom-openai");
if (!secret) { console.log("no saved OpenAI key"); process.exit(0); }
const variants: Array<[string, Record<string, unknown>]> = [
  ["minimal", {}],
  ["max_tokens", { max_tokens: 64 }],
  ["temperature", { temperature: 0.2 }],
  ["stream", { stream: true, stream_options: { include_usage: true } }],
];
for (const [name, extra] of variants) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Say OK." }], ...extra }),
  });
  const text = await response.text();
  const message = /"message":\s*"([^"]*)"/.exec(text)?.[1] ?? text.slice(0, 120);
  console.log(name, response.status, response.ok ? "ok" : message.split(secret).join("[redacted]"));
}
