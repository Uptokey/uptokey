/**
 * Lists the realtime models the saved OpenAI key can use (ids only; the key is never printed).
 *   node scripts/probe-openai-models.ts
 */
import { createOfficialSecretStore } from "../src/secret-store.ts";

const secret = await createOfficialSecretStore().get("provider:custom-openai");
if (!secret) { console.log("no saved OpenAI key"); process.exit(0); }
const response = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${secret}` } });
const body = await response.json() as { data?: Array<{ id: string }> };
console.log("status", response.status);
console.log((body.data ?? []).map((model) => model.id).filter((id) => /realtime/.test(id)).sort().join("\n"));
