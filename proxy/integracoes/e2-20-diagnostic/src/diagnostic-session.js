import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createSanitizer } from "./sanitize.js";
import { generateSessionCa } from "./ephemeral-ca.js";

const BIND_DEFAULT = "127.0.0.1";

function assertLoopback(host) {
  const h = String(host || "").split(":")[0].toLowerCase();
  if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1") {
    const err = new Error("target_not_authorized");
    err.code = "target_not_authorized";
    throw err;
  }
  return h;
}

/**
 * Opt-in DiagnosticSession: explicit loopback proxy, session CA, collect off|redacted,
 * TTL, stop/rollback. Default construction does not listen until start().
 */
export class DiagnosticSession {
  constructor(opts = {}) {
    this.id = opts.sessionId || `ds_${crypto.randomBytes(6).toString("hex")}`;
    this.bind = opts.bind || BIND_DEFAULT;
    this.proxyPort = opts.proxyPort || 0;
    this.ttlMs = opts.ttlMs ?? 15 * 60 * 1000;
    this.collectPolicy = opts.collectPolicy === "redacted" ? "redacted" : "off";
    this.origins = new Set((opts.origins || [`${this.bind}`]).map(String));
    this.canaries = opts.canaries || [];
    this.stateDir = opts.stateDir;
    this.enabled = false; // default OFF
    this.state = "idle";
    this.revision = 1;
    this.records = [];
    this.droppedCount = 0;
    this.createdAt = Date.now();
    this.expiresAt = null;
    this.boundEndpoint = null;
    this._proxy = null;
    this._ttlTimer = null;
    this._leafCache = new Map();
    this.sanitizer = createSanitizer(this.canaries);
    this.ca = null;
    this.receipts = [];
    /** @type {null | { status: string, effectKind: string, requestId: string, phase: string, reason: string, mutatingRetryAllowed: false, at: string, resourcesHint?: string[] }} */
    this.uncertainty = null;
    /** Pending mutating effects awaiting receipt (requestId -> meta). */
    this._pendingEffects = new Map();
  }

  discover() {
    return {
      support: "lab_explicit_loopback_proxy",
      version: "0.1.0-lab",
      license: "lab-harness-not-product",
      configurationRequired: ["opt_in_start", "origins_exact", "collectPolicy"],
      capture: false,
      dnsMutation: false,
      globalTrust: false,
    };
  }

  async start({ approvedPlanRef = "lab-plan", requestId = "req_lab" } = {}) {
    if (this.state === "needs_attention") {
      const err = new Error("uncertain_state");
      err.code = "uncertain_state";
      err.uncertainty = this.uncertainty;
      throw err;
    }
    if (this.state === "active") {
      return this._receipt("start_idempotent");
    }
    if (!this.stateDir) throw new Error("stateDir_required");
    fs.mkdirSync(this.stateDir, { recursive: true });

    // Mark mutating effect before applying; receipt clears it.
    this._markPendingEffect("start", requestId);
    try {
      this.ca = await generateSessionCa(path.join(this.stateDir, "ca"));
      this.enabled = true;
      this.state = "active";
      this.expiresAt = Date.now() + this.ttlMs;
      this._ttlTimer = setTimeout(() => this.stop({ reason: "scope_expired" }), this.ttlMs);
      if (this._ttlTimer.unref) this._ttlTimer.unref();

      await this._listen();
      this.boundEndpoint = `http://${this.bind}:${this.proxyPort}`;
      const receipt = this._receipt("start", { approvedPlanRef, requestId });
      this._clearPendingEffect(requestId);
      return receipt;
    } catch (e) {
      // Effect may be partial — leave uncertainty if listen failed after CA.
      if (this.ca || this._proxy) {
        this.markCrashBeforeReceipt({
          effectKind: "start",
          requestId,
          reason: e.message || "start_failed_before_receipt",
        });
      } else {
        this._clearPendingEffect(requestId);
      }
      throw e;
    }
  }

  _listen() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handleHttp(req, res));
      server.on("connect", (req, clientSocket, head) => {
        this._handleConnect(req, clientSocket, head).catch(() => {
          try { clientSocket.destroy(); } catch { /* ignore */ }
        });
      });
      server.on("error", reject);
      server.listen(this.proxyPort, this.bind, () => {
        const addr = server.address();
        this.proxyPort = addr.port;
        this._proxy = server;
        resolve();
      });
    });
  }

  _originAllowed(hostPort) {
    const host = String(hostPort).split(":")[0].toLowerCase();
    try {
      assertLoopback(host);
    } catch {
      return false;
    }
    if (this.origins.has("*")) return false; // wildcards forbidden
    return [...this.origins].some((o) => {
      const oh = String(o).split(":")[0].toLowerCase();
      return oh === host || o === hostPort;
    });
  }

  _observe(meta) {
    if (this.collectPolicy === "off") {
      this.droppedCount += 1;
      // metadata-only allowed: method/host/path/status — no headers/body
      const slim = {
        ts: new Date().toISOString(),
        method: meta.method,
        host: meta.host,
        path: meta.path,
        status: meta.status,
        collectionState: "off",
      };
      this.records.push(slim);
      return slim;
    }
    const full = this.sanitizer.sanitizeRecord({
      ts: new Date().toISOString(),
      method: meta.method,
      host: meta.host,
      path: meta.path,
      status: meta.status,
      headers: meta.headers,
      body: meta.body,
      collectionState: "redacted",
    });
    this.records.push(full);
    return full;
  }

  _handleHttp(clientReq, clientRes) {
    if (!this.enabled || this.state !== "active") {
      clientRes.writeHead(503, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "diagnostic_disabled" }));
      return;
    }
    if (Date.now() > this.expiresAt) {
      this.stop({ reason: "scope_expired" });
      clientRes.writeHead(403, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "scope_expired" }));
      return;
    }

    // Absolute-form proxy URL: http://127.0.0.1:PORT/path
    let target;
    try {
      if (clientReq.url.startsWith("http://") || clientReq.url.startsWith("https://")) {
        target = new URL(clientReq.url);
      } else {
        const host = clientReq.headers.host || `${this.bind}`;
        target = new URL(`http://${host}${clientReq.url}`);
      }
    } catch {
      clientRes.writeHead(400, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "bad_url" }));
      return;
    }

    if (!this._originAllowed(target.host)) {
      clientRes.writeHead(403, { "content-type": "application/json" });
      clientRes.end(JSON.stringify({ error: "target_not_authorized" }));
      return;
    }

    const chunks = [];
    clientReq.on("data", (c) => chunks.push(c));
    clientReq.on("end", () => {
      const bodyBuf = Buffer.concat(chunks);
      const headers = { ...clientReq.headers };
      delete headers["proxy-connection"];
      headers.host = target.host;

      const upReq = http.request(
        {
          host: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: clientReq.method,
          headers,
        },
        (upRes) => {
          const outChunks = [];
          upRes.on("data", (c) => outChunks.push(c));
          upRes.on("end", () => {
            const outBuf = Buffer.concat(outChunks);
            this._observe({
              method: clientReq.method,
              host: target.host,
              path: target.pathname,
              status: upRes.statusCode,
              headers: clientReq.headers,
              body: bodyBuf.toString("utf8"),
            });
            clientRes.writeHead(upRes.statusCode || 502, {
              ...upRes.headers,
              "x-e2-20-diag": "1",
              "x-e2-20-session": this.id,
            });
            clientRes.end(outBuf);
          });
        }
      );
      upReq.on("error", (err) => {
        clientRes.writeHead(502, { "content-type": "application/json" });
        clientRes.end(
          JSON.stringify({
            error: "backend_unavailable",
            detail: this.sanitizer.redactString(err.message),
          })
        );
      });
      upReq.end(bodyBuf);
    });
  }

  async _getLeaf(host) {
    let pending = this._leafCache.get(host);
    if (!pending) {
      pending = this.ca.issueLeaf(host, `leaf-${host.replace(/[^a-z0-9.-]/gi, "_")}`);
      this._leafCache.set(host, pending);
      try {
        pending = await pending;
        this._leafCache.set(host, pending);
      } catch (e) {
        this._leafCache.delete(host);
        throw e;
      }
    }
    return pending;
  }

  async _handleConnect(req, clientSocket, head) {
    if (!this.enabled || this.state !== "active") {
      clientSocket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      clientSocket.end();
      return;
    }
    const hostPort = req.url; // host:port
    if (!this._originAllowed(hostPort)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    const [host, portStr] = hostPort.split(":");
    const port = Number(portStr || 443);

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // TLS MITM with session CA — trust only for the lab client that loaded this CA.
    // Leaf generation is async (WebCrypto); a failure destroys the socket and never
    // downgrades to plaintext or disables upstream verification.
    let leaf;
    try {
      leaf = await this._getLeaf(host);
    } catch {
      try { clientSocket.destroy(); } catch { /* ignore */ }
      return;
    }

    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: leaf.key,
      cert: leaf.cert,
      ca: this.ca.caPem,
    });
    if (head && head.length) tlsSocket.unshift(head);

    // Minimal HTTPS request parser over the decrypted stream via https-like handling
    const fakeServer = http.createServer((incReq, incRes) => {
      const chunks = [];
      incReq.on("data", (c) => chunks.push(c));
      incReq.on("end", () => {
        const bodyBuf = Buffer.concat(chunks);
        // Forward to real upstream with proper TLS verification (no insecureSkipVerify)
        const upReq = https.request(
          {
            host,
            port,
            path: incReq.url,
            method: incReq.method,
            headers: { ...incReq.headers, host: hostPort },
            servername: host === "127.0.0.1" ? undefined : host,
            // Upstream uses its OWN cert; lab upstream will present cert signed by same session CA
            // or a separate upstream CA passed via env. Here we trust session CA for synthetic upstream.
            ca: this.ca.caPem,
            rejectUnauthorized: true,
          },
          (upRes) => {
            const out = [];
            upRes.on("data", (c) => out.push(c));
            upRes.on("end", () => {
              this._observe({
                method: incReq.method,
                host: hostPort,
                path: incReq.url,
                status: upRes.statusCode,
                headers: incReq.headers,
                body: bodyBuf.toString("utf8"),
              });
              incRes.writeHead(upRes.statusCode || 502, {
                ...upRes.headers,
                "x-e2-20-diag": "1",
              });
              incRes.end(Buffer.concat(out));
            });
          }
        );
        upReq.on("error", (err) => {
          const code =
            err.code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
            err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
            /certificate|TLS|SSL/i.test(err.message)
              ? "certificate_untrusted"
              : "backend_unavailable";
          incRes.writeHead(502, { "content-type": "application/json" });
          incRes.end(
            JSON.stringify({
              error: code,
              detail: this.sanitizer.redactString(err.message),
            })
          );
        });
        upReq.end(bodyBuf);
      });
    });
    fakeServer.emit("connection", tlsSocket);
  }

  certificateInspect() {
    if (!this.ca) return { error: "diagnostic_disabled" };
    return this.ca.inspect();
  }

  observeExport({ cursor = 0 } = {}) {
    const slice = this.records.slice(cursor);
    // Final canary gate
    const blob = JSON.stringify(slice);
    if (!this.sanitizer.assertNoCanaryLeak(blob)) {
      return {
        error: "collection_not_authorized",
        detail: "canary_leak_prevented",
        records: [],
        droppedCount: this.droppedCount,
        collectionState: this.collectPolicy,
      };
    }
    return {
      records: slice,
      droppedCount: this.droppedCount,
      collectionState: this.collectPolicy,
      nextCursor: this.records.length,
      artifactRef: null,
    };
  }

  stop({ reason = "user_stop", requestId = "stop_lab" } = {}) {
    if (this.state === "needs_attention" && reason !== "operator_reconcile") {
      const err = new Error("uncertain_state");
      err.code = "uncertain_state";
      err.uncertainty = this.uncertainty;
      return Promise.reject(err);
    }
    if (this.state === "stopped") {
      return Promise.resolve(this._receipt("stop_idempotent", { reason }));
    }
    this._markPendingEffect("stop", requestId);
    this.enabled = false;
    this.state = "stopping";
    if (this._ttlTimer) clearTimeout(this._ttlTimer);
    const closeProxy = new Promise((resolve) => {
      if (!this._proxy) return resolve();
      this._proxy.close(() => resolve());
    });
    return closeProxy
      .then(() => {
        this.state = "stopped";
        this.revision += 1;
        // Destroy ephemeral CA material (rollback of session trust — never OS trust)
        if (this.ca) this.ca.destroy();
        this.ca = null;
        this._leafCache.clear();
        this._proxy = null;
        const receipt = this._receipt("stop", { reason, resourcesRemaining: [], requestId });
        this._clearPendingEffect(requestId);
        if (reason === "operator_reconcile") {
          this.uncertainty = null;
          this._writeUncertaintyFile(null);
        }
        return receipt;
      })
      .catch((e) => {
        this.markCrashBeforeReceipt({
          effectKind: "stop",
          requestId,
          reason: e.message || "stop_failed_before_receipt",
        });
        throw e;
      });
  }

  /** Simulate reload: must NOT relaunch capture. */
  reload() {
    if (this.state === "stopped" || this.state === "idle") {
      return { state: this.state, relaunched: false };
    }
    return { state: this.state, relaunched: false, note: "reload_does_not_start" };
  }

  _uncertaintyPath() {
    return this.stateDir ? path.join(this.stateDir, "uncertainty.json") : null;
  }

  _markPendingEffect(effectKind, requestId) {
    this._pendingEffects.set(requestId, {
      effectKind,
      requestId,
      phase: "effect_started",
      at: new Date().toISOString(),
    });
    this._writeUncertaintyFile({
      status: "pending",
      effectKind,
      requestId,
      phase: "effect_started",
      reason: "awaiting_receipt",
      mutatingRetryAllowed: false,
      at: new Date().toISOString(),
    });
  }

  _clearPendingEffect(requestId) {
    this._pendingEffects.delete(requestId);
    if (this._pendingEffects.size === 0 && this.state !== "needs_attention") {
      this._writeUncertaintyFile(null);
    }
  }

  _writeUncertaintyFile(payload) {
    const p = this._uncertaintyPath();
    if (!p) return;
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      if (payload == null) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
        return;
      }
      fs.writeFileSync(p, JSON.stringify(payload, null, 2));
    } catch {
      /* best-effort persistence */
    }
  }

  /**
   * Crash-before-receipt: effect applied (or partially applied) but durable
   * receipt was not recorded. State becomes needs_attention / unknown.
   * Mutating traffic MUST NOT be auto-retried.
   */
  markCrashBeforeReceipt({
    effectKind = "unknown",
    requestId = "unknown",
    reason = "crash_before_receipt",
    resourcesHint = [],
  } = {}) {
    this.enabled = false;
    // Lab stand-in for process death: drop listen/TTL handles so Node can exit,
    // but do NOT emit a durable start/stop receipt — outcome stays unknown.
    if (this._ttlTimer) {
      clearTimeout(this._ttlTimer);
      this._ttlTimer = null;
    }
    const hint = Array.isArray(resourcesHint) ? [...resourcesHint] : [];
    if (this.boundEndpoint && !hint.includes(this.boundEndpoint)) {
      hint.push(this.boundEndpoint);
    }
    if (this._proxy) {
      try {
        this._proxy.close();
      } catch {
        /* ignore */
      }
      this._proxy = null;
    }
    this.state = "needs_attention";
    this.uncertainty = {
      status: "unknown",
      effectKind,
      requestId,
      phase: "effect_applied_receipt_missing",
      reason,
      mutatingRetryAllowed: false,
      at: new Date().toISOString(),
      resourcesHint: hint,
    };
    this._writeUncertaintyFile(this.uncertainty);
    return { ...this.uncertainty, state: this.state, sessionRef: this.id, revision: this.revision };
  }

  /** Recover uncertainty marker from stateDir (lab reload / process restart sim). */
  loadUncertaintyFromDisk() {
    const p = this._uncertaintyPath();
    if (!p || !fs.existsSync(p)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      if (raw && (raw.status === "unknown" || raw.phase === "effect_applied_receipt_missing")) {
        this.state = "needs_attention";
        this.enabled = false;
        this.uncertainty = {
          status: "unknown",
          effectKind: String(raw.effectKind || "unknown"),
          requestId: String(raw.requestId || "unknown"),
          phase: "effect_applied_receipt_missing",
          reason: String(raw.reason || "crash_before_receipt"),
          mutatingRetryAllowed: false,
          at: String(raw.at || new Date().toISOString()),
          resourcesHint: Array.isArray(raw.resourcesHint) ? raw.resourcesHint : [],
        };
      }
      return this.uncertainty;
    } catch {
      return null;
    }
  }

  getUncertainty() {
    return this.uncertainty
      ? { ...this.uncertainty, state: this.state, sessionRef: this.id, revision: this.revision }
      : null;
  }

  /** True only when mutating start/stop may proceed; never when needs_attention. */
  allowsMutatingRetry() {
    if (this.state === "needs_attention") return false;
    if (this.uncertainty && this.uncertainty.mutatingRetryAllowed === false) return false;
    return true;
  }

  /**
   * Operator reconcile after needs_attention: stop leftover resources, clear uncertainty.
   * Does not re-issue the original mutating requestId as an automatic retry.
   */
  async reconcileAttention({ requestId = "reconcile_lab" } = {}) {
    if (this.state !== "needs_attention") {
      return { state: this.state, reconciled: false };
    }
    // Best-effort tear-down without claiming the original mutating receipt.
    if (this._ttlTimer) clearTimeout(this._ttlTimer);
    await new Promise((resolve) => {
      if (!this._proxy) return resolve();
      this._proxy.close(() => resolve());
    });
    this._proxy = null;
    if (this.ca) {
      try {
        this.ca.destroy();
      } catch {
        /* ignore */
      }
      this.ca = null;
    }
    this._leafCache.clear();
    this.enabled = false;
    this.state = "stopped";
    this.revision += 1;
    this._pendingEffects.clear();
    const prior = this.uncertainty;
    this.uncertainty = null;
    this._writeUncertaintyFile(null);
    return this._receipt("reconcile", {
      requestId,
      priorUncertainty: prior,
      resourcesRemaining: [],
      note: "operator_reconcile_no_auto_retry",
    });
  }

  _receipt(kind, extra = {}) {
    const r = {
      kind,
      sessionRef: this.id,
      boundEndpoint: this.boundEndpoint,
      state: this.state,
      revision: this.revision,
      collectPolicy: this.collectPolicy,
      expiresAt: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      protocol: "http-proxy+tls-connect",
      destinationPolicy: "loopback_origins_exact",
      ...extra,
    };
    this.receipts.push(r);
    return r;
  }
}
