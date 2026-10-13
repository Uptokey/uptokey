import {
  ACCOUNT_ID,
  ACCOUNT_REF,
  type AccountProof,
} from "./account-login-protocol.ts";
import {
  parseHostedRequest,
  type HostedRequest,
} from "../../contratos/hosted-request.js";

export const ACCOUNT_HOSTED_MAX_REQUEST_BYTES = 262_144;
export const ACCOUNT_HOSTED_MAX_RESPONSE_BYTES = 24_100_000;
export const ACCOUNT_HOSTED_CHAT_TIMEOUT_MS = 135_000;
export type AccountHostedRequest = { accountRef: string; revision: number } & (
  | { operation: "models"; payload: Record<string, never> }
  | {
      operation: "chat";
      payload: HostedRequest & { expectedPriceVersion: string };
    }
  | { operation: "receipt"; payload: { requestId: string } }
);
export interface AccountHostedProof extends Omit<AccountProof, "action"> {
  action: "hosted";
  request: AccountHostedRequest;
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
export function readAccountHostedRequest(value: unknown): AccountHostedRequest {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "accountRef,operation,payload,revision" ||
    typeof value.accountRef !== "string" ||
    !ACCOUNT_REF.test(value.accountRef) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !record(value.payload)
  )
    throw Error("account_request_invalid");
  const identity = { accountRef: value.accountRef, revision: value.revision };
  if (value.operation === "models" && !Object.keys(value.payload).length)
    return { ...identity, operation: "models", payload: {} };
  if (
    value.operation === "receipt" &&
    Object.keys(value.payload).join(",") === "requestId" &&
    typeof value.payload.requestId === "string" &&
    /^[A-Za-z0-9:_-]{1,160}$/.test(value.payload.requestId)
  )
    return {
      ...identity,
      operation: "receipt",
      payload: { requestId: value.payload.requestId },
    };
  if (value.operation === "chat") {
    try {
      const payload = parseHostedRequest(value.payload);
      if (
        !payload.expectedPriceVersion ||
        new TextEncoder().encode(JSON.stringify(payload)).byteLength > 256_000
      )
        throw Error();
      return {
        ...identity,
        operation: "chat",
        payload: {
          ...payload,
          expectedPriceVersion: payload.expectedPriceVersion,
        },
      };
    } catch {
      throw Error("account_request_invalid");
    }
  }
  throw Error("account_request_invalid");
}
export function accountHostedProofPayload(
  proof: Omit<AccountHostedProof, "signature">,
): string {
  if (!ACCOUNT_ID.test(proof.id) || proof.action !== "hosted")
    throw Error("account_proof_invalid");
  const request = readAccountHostedRequest(proof.request);
  return JSON.stringify([
    "uptokey.account.hosted.v1",
    proof.id,
    proof.action,
    proof.nonce,
    proof.issuedAt,
    request.accountRef,
    request.revision,
    request.operation,
    request.payload,
  ]);
}
