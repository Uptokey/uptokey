export const SERVICE_ACCESS_VERSION:1;
export const SERVICE_ID:RegExp;
export const SERVICE_STATES:readonly string[];
export interface ServiceOperation {id:string;label:string;effect:'read_external'|'write_external';inputSchema:Record<string,unknown>}
export interface ServiceView {id:string;runtimeId:string;label:string;resourceIds:string[];aliases:string[];kind:'api'|'productivity'|'mcp'|'channel'|'tool';scope:'device'|'project';auth:'none'|'api-key'|'oauth';documentationUrl:string|null;getKeyUrl:string|null;endpointUrl:string|null;revision:number;state:'ready'|'unconfigured'|'configured'|'disabled'|'removed'|'error';enabled:boolean;connectionId:string|null;credentialPresent:boolean;operations:ServiceOperation[];errorCode:string|null;connections?:{id:string;label:string;enabled:boolean;credentialPresent:boolean}[];setup?:{kind:'oauth';providerId:string;scopes:string[]}}
export interface ServiceCatalog {schemaVersion:1;services:ServiceView[]}
export interface ServiceMutation {expectedRevision:number;credential?:string;connectionId?:string;label?:string;enabled?:boolean}
export interface ServicePlanInput {expectedRevision:number;serviceId:string;serviceRevision:number;operationId:string;parameters:Record<string,unknown>}
export function parseServiceMutation(input:unknown,kind:'configure'|'update'|'discover'|'remove'):ServiceMutation;
export function parseServicePlan(input:unknown):ServicePlanInput;
export function parseServiceCatalog(input:unknown):ServiceCatalog;
export function parseServiceView(input:unknown):ServiceView;
