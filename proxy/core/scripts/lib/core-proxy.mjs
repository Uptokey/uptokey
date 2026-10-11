/**
 * A transparent TCP relay between the terminal frontend and the fixture core, used by the J21 journey to inject the
 * failures a real network/daemon produces without touching the core itself:
 *   - down():   existing connections are cut and new ones are closed on accept (core restarting / unreachable);
 *   - up():     connections are relayed again;
 *   - dropAckOnce(pattern): the next request whose request line matches reaches the core, which processes it, but the
 *     client connection is cut as soon as the response starts (the acknowledgement is lost).
 * Bytes are relayed untouched (streaming answers keep working); only request lines are inspected.
 */
import { createServer, connect } from "node:net";

export async function startCoreProxy() {
  let target = null;
  let down = false;
  let dropPattern = null;
  const sockets = new Set();
  const events = [];

  const server = createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => undefined);
    if (down || !target) { client.destroy(); return; }
    const upstream = connect(target.port, target.host);
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
    upstream.on("error", () => client.destroy());
    let dropping = false;
    client.on("data", (chunk) => {
      if (dropPattern) {
        const head = chunk.toString("latin1", 0, Math.min(chunk.length, 512));
        const line = head.split("\r\n")[0] ?? "";
        if (dropPattern.test(line)) { dropping = true; events.push({ dropped: line, at: Date.now() }); dropPattern = null; }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (dropping) { client.destroy(); upstream.destroy(); return; }
      client.write(chunk);
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
  });
  await new Promise((resolveListening, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListening); });
  const port = server.address().port;
  return {
    port,
    events,
    setTarget(host, targetPort) { target = { host, port: targetPort }; },
    down() { down = true; for (const socket of sockets) socket.destroy(); sockets.clear(); },
    up() { down = false; },
    dropAckOnce(pattern) { dropPattern = pattern; },
    close() { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}
