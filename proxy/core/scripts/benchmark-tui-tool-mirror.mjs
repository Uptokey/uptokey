import { SessionMirror } from "../src/tui/frontend/uptokey/backend/mirror.ts";

// Focused serializer benchmark, not a terminal/UI latency certification.
const tools = 100, outputBytes = 256 * 1024, iterations = 50;
const output = "x".repeat(outputBytes);
const info = {id:"assistant", sessionID:"benchmark", role:"assistant", time:{created:1}, parentID:"user", modelID:"m", providerID:"p", mode:"build", agent:"build", path:{cwd:"/benchmark", root:"/benchmark"}, cost:0, tokens:{input:0, output:0, reasoning:0, cache:{read:0,write:0}}};
const fixed = Array.from({length:tools}, (_, index) => ({id:`tool-${index}`, sessionID:"benchmark", messageID:"assistant", type:"tool", callID:`call-${index}`, tool:"read",
  state:{status:"completed", input:{path:`fixture-${index}`}, output, title:"read", metadata:{receipt:`r-${index}`}, time:{start:1,end:2}}}));
const projection = text => [{info, parts:[...fixed, {id:"tail", sessionID:"benchmark", messageID:"assistant", type:"text", text}]}];
const mirror = new SessionMirror("benchmark");
let text = "answer";
mirror.diff(projection(text));
const timings = [], eventCounts = [];
for (let index = 0; index < iterations; index++) {
  text += ` token-${index}`;
  const started = performance.now();
  const result = mirror.diff(projection(text));
  timings.push(performance.now() - started);
  eventCounts.push(result.events.length);
  if (result.resync || result.events.length !== 1 || result.events[0].type !== "message.part.delta") throw new Error("benchmark_projection_changed");
}
const ordered = [...timings].sort((a,b) => a-b);
process.stdout.write(JSON.stringify({scope:"SessionMirror serializer only", tools, outputBytesPerTool:outputBytes, logicalOutputBytes:tools*outputBytes, iterations,
  p50Ms:ordered[Math.floor(ordered.length*.5)], p95Ms:ordered[Math.floor(ordered.length*.95)], maxMs:ordered.at(-1),
  eventCounts:[...new Set(eventCounts)], totalMs:timings.reduce((sum,value)=>sum+value,0)}, null, 2) + "\n");
