import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";
import { parsePairingAudience, type PairingAudience } from "@uptokey/sync-contract/client-keys";

export type PairingApproval = { id: string; userCode: string; audience?: PairingAudience };

export function parsePairingApprovalArgs(args: readonly string[]): PairingApproval {
  if ((args.length !== 2 && args.length !== 4) || (args.length === 4 && args[2] !== "--audience")) throw new Error("Use: uptokey proxy pair approve <challenge-id> <codigo> [--audience legacy|vscode|browser-extension|tauri|tui]");
  return { id: args[0]!, userCode: args[1]!, audience: parsePairingAudience(args[3]) };
}

export type LocalAdminPath = "/local/pair/approve" | "/local/control-pair/approve" | "/local/control-pair/revoke" | "/local/config/reload" | "/local/cache/invalidate/groq" | "/local/cache/invalidate/gemini" | "/local/cache/invalidate/ollama" | "/local/cache/invalidate/vllm" | "/local/cache/invalidate/custom" | "/local/cache/invalidate/deepseek" | "/local/cache/invalidate/mistral" | "/local/cache/invalidate/cerebras" | "/local/cache/invalidate/together" | "/local/cache/invalidate/anthropic" | "/local/cache/invalidate/openrouter" | "/local/update/authorize-stop";

/** Approval routes return a JSON acknowledgement (200), unlike no-content mutations (204). */
export async function approveLocalPairing(path: "/local/pair/approve" | "/local/control-pair/approve", token: string, body: PairingApproval, fetcher: typeof fetch = fetch): Promise<void> {
  const status = await localAdminRequest(path, token, body, fetcher);
  if (status !== 200) throw new Error(status === 404 ? "local_pairing_invalid_or_expired" : "local_pairing_not_approved");
}

export async function localAdminRequest(path: LocalAdminPath, token: string, body?: PairingApproval | { pid: number }, fetcher: typeof fetch = fetch, timeoutMs = 5_000): Promise<number> {
  if (!/^utk_local_[A-Za-z0-9_-]{32}$/.test(token)) throw new Error("local_admin_token_invalid");
  const approve = path.endsWith("/approve");
  const updateStop = path === "/local/update/authorize-stop";
  if (approve) { if (!body || !("id" in body) || !/^[A-Za-z0-9_-]{3,100}$/.test(body.id) || !/^[A-Fa-f0-9]{6,8}$/.test(body.userCode)) throw new Error("local_admin_request_invalid"); }
  else if (updateStop) { if (!body || !("pid" in body) || !Number.isSafeInteger(body.pid) || body.pid <= 1) throw new Error("local_admin_request_invalid"); }
  else if (body) throw new Error("local_admin_request_invalid");
  if (body && "id" in body && body.audience !== undefined) {
    if (path !== "/local/pair/approve") throw new Error("local_admin_request_invalid");
    parsePairingAudience(body.audience);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error("local_admin_timeout_invalid");
  const deadline = createDeadline(timeoutMs); const signal = deadline.signal; let response: Response;
  try {
    response = await fetcher(new URL(path, "http://127.0.0.1:21435"), {
      method: "POST", redirect: "error", signal,
      headers: { Host: "127.0.0.1:21435", Accept: "application/json", authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify("id" in body ? { id: body.id, userCode: body.userCode.toUpperCase(), ...(body.audience === undefined ? {} : { audience: body.audience }) } : { pid: body.pid }) } : {}),
    });
  } catch { throw new Error(signal.aborted ? "local_admin_timeout" : "local_admin_unavailable"); }
  finally { deadline.clear(); }
  cancelStream(response.body);
  return response.status;
}
