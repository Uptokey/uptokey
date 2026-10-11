/**
 * J18 — MCP and web tools return to the same model through the core: the model asks for a tool, the person approves
 * the exact operation in the terminal, the core runs it (official MCP filesystem server on its own root; the core's
 * governed web fetch) and the result goes back to the model. Declining sends nothing and invents no result.
 */
import assert from "node:assert/strict";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;

async function approveAndExpect(term, request, expected, label) {
  await term.send("\x15");
  await term.send(request);
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()), `${label}: approval was not requested`, 40000);
  const approvalScreen = term.screen();
  await term.send(ENTER);
  await term.until(() => term.screen().includes(expected), `${label}: the tool result did not reach the model`, 40000);
  return approvalScreen;
}

export async function toolsJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  const toolResults = async () => (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json()).map((entry) => entry.toolResult).filter(Boolean);
  try {
  const mcpApproval = await approveAndExpect(term, "LER_MCP nota do servidor", "Ferramenta devolveu: MCP_MARKER_9123", "MCP");
  checks.mcpApprovalShown = /read_text_file|nota-mcp\.txt|MCP/i.test(mcpApproval);
  checks.mcpResultReturnedToModel = true;
  capture("1. MCP aprovado e devolvido ao modelo");

  const webApproval = await approveAndExpect(term, "LER_WEB guia publico", "Ferramenta devolveu: WEB_MARKER_5511", "web");
  checks.webApprovalShowsUrl = webApproval.includes("docs.example.com");
  assert.ok(checks.webApprovalShowsUrl, "the web approval does not show the exact URL");
  checks.webResultReturnedToModel = true;
  capture("2. web aprovada e devolvida ao modelo");

  // Declining: nothing runs and no marker appears for this turn.
  await term.send("\x15");
  await term.send("LER_MCP de novo recusado");
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()), "declined MCP: approval was not requested", 40000);
  await term.send("\x1b[C");
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 3000));
  const after = term.screen().split("LER_MCP de novo recusado").at(-1) ?? "";
  assert.ok(!after.includes("MCP_MARKER_9123"), "a declined tool produced a result");
  checks.declinedProducesNoResult = true;
  checks.screenAfterDecline = after.split("\n").filter((line) => line.trim()).slice(0, 8).join("\n");
  capture("3. MCP recusado");
  } finally {
    checks.toolResultsSeenByModel = await toolResults().catch(() => null);
  }
}
