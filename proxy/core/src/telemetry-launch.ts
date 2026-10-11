import { createHash } from 'node:crypto';
import { asDataRecord } from '@uptokey/sync-contract/plain-data';
import { parseLangfuseEndpoint,parseCollectorEndpoint } from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import { updateConfig } from './config.ts';
import { readTerminalSecret } from './terminal-secret.ts';
import type { SecretStore } from './secret-store.ts';
import type { ProxyConfig } from './types.ts';
import type { WorkspaceStore } from './workspace/store.ts';
import type { WorkspaceTelemetryExporterOptions } from './workspace/telemetry-exporter.ts';
import type { WorkspaceTelemetryOutbox } from './workspace/telemetry-outbox.ts';

export const LANGFUSE_CREDENTIAL_ACCOUNT = 'local:telemetry:langfuse';
const SECRET_LIMIT = 512;
type CredentialPair = { schemaVersion: 1; endpoint: string; publicKey: string; secretKey: string };

/** One vault record binds both keys to their endpoint; configuration contains no keys or persistent opt-in. */
export async function configureLangfuseTelemetry(endpointInput: string, secrets: SecretStore,
  prompt: (label: string, maxLength: number) => Promise<string> = readTerminalSecret,
  persist: (mutator: (config: ProxyConfig) => void) => Promise<unknown> = updateConfig): Promise<void> {
  const endpoint = parseLangfuseEndpoint(endpointInput);
  const publicKey = await prompt('Langfuse local — chave pública (oculta): ', SECRET_LIMIT);
  const secretKey = await prompt('Langfuse local — chave secreta (oculta): ', SECRET_LIMIT);
  const pair = parsePair(JSON.stringify({ schemaVersion: 1, endpoint, publicKey, secretKey }));
  await secrets.set(LANGFUSE_CREDENTIAL_ACCOUNT, JSON.stringify(pair));
  // These stores are not transactional. A failed config write leaves an endpoint-bound pair,
  // which the resolver refuses to use with the previous endpoint.
  await persist(config => { config.workspaceTelemetry = { kind: 'langfuse', endpoint }; });
}

/** Builds no process or connection; resolves keys for each SDK batch and pins the destination identity. */
export async function langfuseExportOptions(config: ProxyConfig, secrets: SecretStore): Promise<{
  destinationId: string; options: WorkspaceTelemetryExporterOptions;
}> {
  if (config.workspaceTelemetry?.kind !== 'langfuse') throw unavailable();
  const endpoint = parseLangfuseEndpoint(config.workspaceTelemetry.endpoint);
  const read = async () => {
    try {
      const pair = parsePair(await secrets.get(LANGFUSE_CREDENTIAL_ACCOUNT));
      if (pair.endpoint !== endpoint) throw unavailable();
      return pair;
    } catch { throw unavailable(); }
  };
  const { publicKey } = await read();
  const destinationId = createHash('sha256').update(JSON.stringify([endpoint, publicKey])).digest('hex');
  return { destinationId, options: { endpoint, resolveCredentials: async signal => {
    if (signal.aborted) throw unavailable();
    const pair = await read();
    if (signal.aborted || pair.publicKey !== publicKey) throw unavailable();
    return { publicKey: pair.publicKey, secretKey: pair.secretKey };
  } } };
}

/** Disabled by default: no telemetry credential reads, SDK imports or outbox resume without the flag. */
export async function createLangfuseTelemetry(enabled: 'langfuse' | undefined, config: ProxyConfig,
  secrets: SecretStore, store: WorkspaceStore): Promise<WorkspaceTelemetryOutbox | undefined> {
  if (enabled === undefined) return undefined;
  if (enabled !== 'langfuse') throw unavailable();
  const { destinationId, options } = await langfuseExportOptions(config, secrets);
  const { createWorkspaceTelemetryExporter } = await import('./workspace/telemetry-exporter.ts');
  const { WorkspaceTelemetryOutbox } = await import('./workspace/telemetry-outbox.ts');
  return new WorkspaceTelemetryOutbox(store, createWorkspaceTelemetryExporter(options), destinationId);
}

/** Explicit local endpoint; no credential lookup, process provisioning or OTEL environment defaults. */
export async function createCollectorTelemetry(endpointInput:string,store:WorkspaceStore):Promise<WorkspaceTelemetryOutbox>{
  const endpoint=parseCollectorEndpoint(endpointInput);
  const [{WorkspaceTelemetryOutbox},{createCollectorTelemetryExporter,createCollectorRuntime}]=await Promise.all([
    import('./workspace/telemetry-outbox.ts'),import('./workspace/telemetry-collector.ts')]);
  const destinationId=createHash('sha256').update(JSON.stringify(['collector-local',endpoint])).digest('hex');
  class CollectorOutbox extends WorkspaceTelemetryOutbox {
    private readonly runtime;
    constructor(){
      super(store,createCollectorTelemetryExporter({endpoint}),destinationId);
      this.runtime=createCollectorRuntime({outbox:{flushProject:(owner,project)=>super.flushProject(owner,project),close:()=>super.close()},listTargets:()=>store.listJournalProjects()});
    }
    override notify(owner:string,project:string){this.runtime.notify(owner,project);}
    override resume(){return this.runtime.resume();}
    override close(){return this.runtime.close();}
  }
  return new CollectorOutbox();
}

function parsePair(value: unknown): CredentialPair {
  try {
    if (typeof value !== 'string' || value.length > 4096) throw unavailable();
    const pair = asDataRecord(JSON.parse(value));
    if (!pair || Object.keys(pair).sort().join(',') !== 'endpoint,publicKey,schemaVersion,secretKey' || pair.schemaVersion !== 1 ||
      !key(pair.publicKey) || pair.publicKey.includes(':') || !key(pair.secretKey)) throw unavailable();
    return { schemaVersion: 1, endpoint: parseLangfuseEndpoint(pair.endpoint), publicKey: pair.publicKey, secretKey: pair.secretKey };
  } catch { throw unavailable(); }
}
function key(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= SECRET_LIMIT && !/[\u0000-\u0020\u007f]/.test(value);
}
function unavailable(): Error { return new Error('quimera_telemetry_configuration_unavailable'); }
