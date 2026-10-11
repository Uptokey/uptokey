/**
 * J18 — real web search without a key: the model asks for web_search, the person approves, the core queries the local
 * SearXNG (metasearch over public engines, on the internet) and the results return to the model. Needs the local
 * SearXNG instance (http://127.0.0.1:8888); opt-in journey.
 */
import assert from "node:assert/strict";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;

export async function searchJourney({ term, checks, capture }) {
  const health = await fetch("http://127.0.0.1:8888/healthz").then((response) => response.ok, () => false);
  assert.ok(health, "the local SearXNG is not running on 127.0.0.1:8888");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("BUSCAR_WEB sobre o Uptokey");
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()), "the search was not offered for approval", 40000);
  checks.searchNeedsApproval = /Uptokey/.test(term.screen());
  capture("1. aprovação da busca");
  await term.send(ENTER);
  await term.until(() => /Busca devolveu \d+ fontes/.test(term.screen()), "the search result did not return to the model", 90000);
  const match = /Busca devolveu (\d+) fontes \(([a-z ]+)\)/.exec(term.screen());
  checks.sources = Number(match?.[1] ?? 0);
  checks.engine = match?.[2] ?? null;
  assert.ok(checks.sources > 0, "the real search returned no public source");
  assert.equal(checks.engine, "searxng", "the search did not go through the local SearXNG");
  capture("2. resultados reais devolvidos ao modelo");
}
