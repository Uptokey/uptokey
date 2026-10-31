export type ProviderSetupLocale = 'en'|'pt-BR'|'es'|'fr'|'de'|'it'|'ja'|'ko'|'zh-CN'|'ar';
export interface ProviderSetupPreset { id:string; label:string; protocol:'openai'|'anthropic'|'gemini'; local:boolean; endpointUrl:string; discovery?:'models'|'manual'|'catalog'; documentationUrl?:string; getKeyUrl?:string; endpointRequired?:boolean; endpointPlaceholder?:string; endpointHostSuffix?:string }
export interface PreparedProviderSetup { id:string; providerId:string; label:string; models:{id:string;name?:string}[]; source:'discovered'|'declared'; notice:string|null; noticeByLocale:Record<ProviderSetupLocale,string>|null; expiresAt:string; connectionId?:string; expectedRevision?:number; reusingStoredCredential?:true }
export interface ProviderDestination { providerId:string; connectionId:string; modelId:string; accountLabel:string }
export class ProviderSetupClientError extends Error { readonly status:number; readonly retryAfterSeconds?:number; constructor(code:string,status:number,retryAfterSeconds?:number) }
export function parseProviderPresets(input:unknown):ProviderSetupPreset[];
export function parsePreparedProviderSetup(input:unknown):PreparedProviderSetup;
export function parseProviderDestination(input:unknown):ProviderDestination;
export interface ProviderSetupProtocolClient {
 presets(signal?:AbortSignal):Promise<ProviderSetupPreset[]>;
 prepare(input:{providerId:string;apiKey?:string;customEndpoint?:string;manualModel?:string;label?:string;connectionId?:string;expectedRevision?:number},signal?:AbortSignal):Promise<PreparedProviderSetup>;
 commit(id:string,modelId:string,signal?:AbortSignal):Promise<ProviderDestination>;
 dispose(id:string):Promise<void>;
}
export function createProviderSetupProtocolClient(request:(path:string,input?:unknown,signal?:AbortSignal)=>Promise<unknown>):ProviderSetupProtocolClient;
export function refreshProviderConnection(client:ProviderSetupProtocolClient,input:{providerId:string;connectionId:string;expectedRevision:number;currentModels:string[]},signal?:AbortSignal):Promise<ProviderDestination&{models:string[];changed:boolean}>;
