/**
 * B9-reparo (frente B) — rotas locais de mobilidade (`/v1/workspace/mobility*`).
 * Capacidade: GET → sync:read; POST → sync:write (client-access-enforcement).
 * Respostas `no-store`; a frase de recuperação volta uma única vez ao
 * solicitante e nunca é persistida nem registrada.
 */
import { MobilityError, type MobilityService } from "./mobility-service.ts";
import { VaultError } from "./vault-service.ts";
import { SinkAccessDeniedError } from "./sink-authority.ts";

let bound: MobilityService | undefined;
export function bindMobilityService(service: MobilityService | undefined): void { bound = service; }
export function getBoundMobilityService(): MobilityService | undefined { return bound; }
/** Disponibilidade real do transporte remoto (sem principal: apenas fonte/origem). */
export function mobilityCapabilityFacet(service: MobilityService | undefined): { mobility: { available: boolean; reason?: string } } {
  return { mobility: service ? service.remoteAvailability() : { available: false, reason: "mobility_unbound" } };
}

const OBJECT = "[A-Za-z0-9_:-]{3,100}";
const READ = new RegExp(`^/v1/workspace/mobility(?:/objects/${OBJECT})?$`);
const WRITE = new RegExp(`^/v1/workspace/mobility/(?:preference|enroll|recovery/(?:create|restore)|objects/${OBJECT}/(?:write|push|pull|remove|resolve))$`);

export function mobilityMethod(path: string, method?: string): "GET" | "POST" | undefined {
  if (READ.test(path)) return method === undefined || method === "GET" ? "GET" : undefined;
  if (WRITE.test(path)) return "POST";
  return undefined;
}

export async function handleMobilityHttp(method: string, path: string, input: unknown, context: { service: MobilityService; principalId: string; signal?: AbortSignal }): Promise<{ status: number; body: unknown } | undefined> {
  if (!mobilityMethod(path, method)) return undefined;
  const { service, principalId, signal } = context;
  const parts = path.split("/").slice(4);
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  try {
    if (parts.length === 0 && method === "GET") return ok(await service.status(principalId));
    if (parts[0] === "preference" && method === "POST") return ok({ preference: await service.setPreference(principalId, input) });
    if (parts[0] === "enroll" && method === "POST") return ok(await service.enroll(principalId));
    if (parts[0] === "recovery" && parts[1] === "create" && method === "POST") return result(await service.createRemoteRecovery(principalId, { rotate: body.rotate === true }, signal));
    if (parts[0] === "recovery" && parts[1] === "restore" && method === "POST") return result(await service.restoreRemoteRecovery(principalId, { recoveryPhrase: typeof body.recoveryPhrase === "string" ? body.recoveryPhrase : "", replace: body.replace === true }, signal));
    if (parts[0] === "objects" && parts[1]) {
      const objectId = parts[1];
      if (parts.length === 2 && method === "GET") {
        const local = await service.readLocal(principalId, objectId);
        if (!local) return { status: 404, body: { error: { type: "mobility_local_missing" } } };
        return ok({ objectId, payloadBase64: Buffer.from(local.payload).toString("base64"), sync: local.sync, confirmedVersion: local.confirmedVersion });
      }
      switch (parts[2]) {
        case "write": {
          if (typeof body.payloadBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.payloadBase64)) throw new MobilityError("mobility_payload_invalid");
          return ok(await service.writeLocal(principalId, objectId, Buffer.from(body.payloadBase64, "base64")));
        }
        case "push": return result(await service.push(principalId, objectId, signal));
        case "pull": return result(await service.pull(principalId, objectId, signal));
        case "remove": return result(await service.remove(principalId, objectId, signal));
        case "resolve": return result(await service.resolve(principalId, objectId, body.choice, signal));
      }
    }
    return { status: 405, body: { error: { type: "method_not_allowed" } } };
  } catch (error) {
    if (error instanceof MobilityError || error instanceof VaultError) return { status: error.status, body: { error: { type: error.code } } };
    if (error instanceof SinkAccessDeniedError) return { status: 403, body: { error: { type: error.code } } };
    throw error;
  }
}

function ok(body: unknown): { status: number; body: unknown } { return { status: 200, body }; }
function result(value: unknown): { status: number; body: unknown } {
  const record = value as { state?: string; status?: number; code?: string };
  if (record?.state === "refused") return { status: record.status && record.status >= 400 && record.status < 600 ? record.status : 409, body: { error: { type: record.code } } };
  return { status: 200, body: value };
}