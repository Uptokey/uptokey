/**
 * One real speech-to-text call with the provider "custom" credential from the person's vault, never printing it.
 *   node scripts/probe-ovh-transcription.ts <wav> <endpoint> <model>
 */
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { createOfficialSecretStore } from "../src/secret-store.ts";

const [wav, endpoint, model] = process.argv.slice(2);
const config = await loadConfig();
const id = process.env.PROBE_PROVIDER ?? "custom"; console.log("providers:", Object.keys(config.providers)); const custom = (config.providers as Record<string, { baseUrl?: string; enabled?: boolean }>)[id];
console.log("custom provider:", custom ? { baseUrl: custom.baseUrl, enabled: custom.enabled } : null);
const secret = await createOfficialSecretStore().get(`provider:${id}`);
console.log("credential present:", Boolean(secret));
if (!secret || !wav) process.exit(0);
const form = new FormData();
form.set("model", model!);
form.set("response_format", "verbose_json");
form.set("file", new Blob([await readFile(wav)], { type: "audio/wav" }), "audio.wav");
const response = await fetch(endpoint!, { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: form });
const text = await response.text();
console.log("status", response.status, text.slice(0, 400).split(secret).join("[redacted]"));
