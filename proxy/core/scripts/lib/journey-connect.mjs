/** J02/J03: first-run provider onboarding through the real terminal (masked key, discovery, selection). */
import assert from "node:assert/strict";

const CTRL_P = "\x10";
const ENTER = "\r";

export async function connectJourney({ term, checks, capture }) {
  await term.until(() => /Uptokey|uptokey/i.test(term.screen()), "interface did not draw", 30000);
  // First run: the provider list opens by itself because no destination is connected yet.
  await term.until(() => /Conectar um provedor|Connect a provider/.test(term.screen()), "onboarding did not open the provider list");
  capture("1. onboarding automatico");
  checks.providerListShown = true;
  await term.send("ovh");
  await term.until(() => term.screen().includes("OVHcloud AI Endpoints"), "filter did not show OVHcloud");
  capture("2. filtro por provedor");
  await term.send(ENTER);
  await term.until(() => /Conectar OVHcloud|Connect OVHcloud/i.test(term.screen()), "key prompt did not open");
  const key = "fixture_key_canary_91";
  await term.send(key);
  await term.until(() => term.screen().includes("•".repeat(8)), "key was not masked");
  assert.ok(!term.screen().includes(key), "the key must never be rendered");
  checks.keyMasked = true;
  capture("3. chave mascarada");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("fixture-coder"), "discovered models were not listed");
  checks.modelsDiscovered = true;
  capture("4. modelos descobertos");
  await term.send(ENTER);
  await term.until(() => /conectado|connected|Não foi possível|could not be completed/i.test(term.screen()), "connection was not confirmed", 30000);
  assert.ok(!/Não foi possível|could not be completed/i.test(term.screen()), `connection failed: ${term.screen().split("\n").filter((line) => /Não foi|could not/.test(line)).join(" | ")}`);
  checks.connected = true;
  capture("5. conectado");
  assert.ok(!term.raw().includes(key), "the key must not appear anywhere in the terminal output");
  checks.noKeyInTerminalOutput = true;
}
