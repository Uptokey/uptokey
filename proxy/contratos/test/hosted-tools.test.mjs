import test from "node:test";
import assert from "node:assert/strict";
import { parseHostedRequest } from "../hosted-request.js";
import { parseHostedClientResult, parseHostedToolCalls } from "../hosted-result.js";
import { projectHostedCatalog } from "../hosted-catalog.js";

const tool = { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };
const base = { requestId: "r-1", model: "free/code", expectedPriceVersion: "v1" };

test("the real 41-tool Harness envelope fits the bounded provider toolset while count and byte limits remain enforced",()=>{
 const input=count=>({...base,messages:[{role:'user',content:'synthetic'}],tools:Array.from({length:count},(_,i)=>({type:'function',function:{name:'fixture_'+i,description:'Synthetic tool',parameters:{type:'object',properties:{}}}}))});
 assert.equal(parseHostedRequest(input(41)).tools.length,41);
 assert.equal(parseHostedRequest(input(128)).tools.length,128);
 assert.throws(()=>parseHostedRequest(input(129)),/hosted_request_invalid/);
 const oversized=input(41);for(const t of oversized.tools)t.function.parameters.description='x'.repeat(2000);
 assert.throws(()=>parseHostedRequest(oversized),/hosted_request_too_large/);
});

test("a hosted request may declare function tools and carry a complete tool exchange", () => {
  const parsed = parseHostedRequest({ ...base, tools: [tool], messages: [
    { role: "user", content: "Read a.js" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.js\"}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"text\":\"x\"}" },
  ] });
  assert.equal(parsed.tools[0].function.name, "read_file");
  assert.deepEqual(parsed.messages[1].tool_calls[0].function, { name: "read_file", arguments: "{\"path\":\"a.js\"}" });
  assert.equal(parsed.messages[2].tool_call_id, "call_1");
  assert.ok(Object.isFrozen(parsed.tools));
});

test("tool exchanges without declared tools, bad names and unknown fields are refused", () => {
  const cases = [
    { ...base, messages: [{ role: "user", content: "x" }, { role: "tool", tool_call_id: "c", content: "y" }] },
    { ...base, messages: [{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }] },
    { ...base, tools: [{ ...tool, function: { ...tool.function, name: "bad name" } }], messages: [{ role: "user", content: "x" }] },
    { ...base, tools: [tool, tool], messages: [{ role: "user", content: "x" }] },
    { ...base, tools: [{ ...tool, extra: true }], messages: [{ role: "user", content: "x" }] },
    { ...base, tools: [], messages: [{ role: "user", content: "x" }] },
    { ...base, tools: [tool], messages: [{ role: "user", content: "x" }, { role: "tool", content: "y" }] },
  ];
  for (const value of cases) assert.throws(() => parseHostedRequest(value), /hosted_request_invalid/, JSON.stringify(value).slice(0, 120));
  const huge = { ...tool, function: { ...tool.function, parameters: { type: "object", description: "x".repeat(70_000) } } };
  assert.throws(() => parseHostedRequest({ ...base, tools: [huge], messages: [{ role: "user", content: "x" }] }), /hosted_request_too_large/);
});

test("a completed result carries tool calls exactly with finishReason tool_calls", () => {
  const completed = { status: "completed", requestId: "r-1", content: "", currency: "USD", chargedMicros: 0, priceVersion: "v1", usage: { inputTokens: 10, outputTokens: 4 } };
  const calls = [{ id: "call_1", name: "read_file", arguments: "{}" }];
  assert.deepEqual(parseHostedClientResult({ ...completed, finishReason: "tool_calls", toolCalls: calls }, 200, "r-1").toolCalls, calls);
  assert.equal(parseHostedClientResult({ ...completed, toolCalls: calls }, 200, "r-1").status, "outcome_unknown", "calls without the reason are not trusted");
  assert.equal(parseHostedClientResult({ ...completed, finishReason: "tool_calls" }, 200, "r-1").status, "outcome_unknown", "the reason without calls is not trusted");
  assert.equal(parseHostedToolCalls([{ id: "a", name: "f", arguments: "{}" }, { id: "a", name: "f", arguments: "{}" }]), null, "duplicate ids");
  assert.equal(parseHostedToolCalls(undefined), undefined);
  assert.deepEqual(parseHostedClientResult({ error: "hosted_tools_unsupported" }, 400, "r-1"), { status: "rejected", requestId: "r-1", error: "hosted_tools_unsupported" });
});

test("the catalog advertises tool support only as an explicit capability", () => {
  const catalog = (toolCalls) => ({ transport: "json", admissionRequired: true, billing: { currency: "USD", unit: "micro_usd", rateBasisTokens: 1_000_000, settlement: "provider_reported_usage" },
    models: [{ id: "free/code", price: { model: "free/code", version: "v1", currency: "USD", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 }, limits: { inputTokens: 8000, outputTokens: 1000, contextTokens: 8000 }, inputReservation: "full_context", contextValidation: "provider", ...(toolCalls === undefined ? {} : { toolCalls }) }] });
  assert.equal(projectHostedCatalog(catalog(true)).models[0].toolCalls, true);
  assert.equal(projectHostedCatalog(catalog(undefined)).models[0].toolCalls, undefined);
  assert.throws(() => projectHostedCatalog(catalog(false)), /hosted_catalog_invalid/);
});
