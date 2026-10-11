import {isDataRecord} from './plain-data.js';
export const SERVICE_ACCESS_VERSION=1;
export const SERVICE_ID=/^[a-z][a-z0-9_-]{0,79}$/;
export const SERVICE_STATES=['ready','unconfigured','configured','disabled','removed','error'];
const fail=()=>{throw new Error('service_input_invalid');};
export function parseServiceMutation(input,kind){
 if(!isDataRecord(input)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail();
 const fields=kind==='configure'?['expectedRevision','credential','label','connectionId']:kind==='update'?['expectedRevision','enabled','label']:kind==='discover'?['expectedRevision','connectionId']:['expectedRevision'];
 if(Object.keys(input).some(key=>!fields.includes(key)))fail();
 if(input.connectionId!==undefined&&(typeof input.connectionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.connectionId)))fail();
 if(input.credential!==undefined&&(typeof input.credential!=='string'||input.credential.length<1||input.credential.length>512||/[\r\n\0]/.test(input.credential)))fail();
 if(input.label!==undefined&&(typeof input.label!=='string'||!input.label.trim()||input.label.length>120||/[\x00-\x1f]/.test(input.label)))fail();
 if(input.enabled!==undefined&&typeof input.enabled!=='boolean')fail();
 return {...input};
}
export function parseServicePlan(input){
 if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='expectedRevision,operationId,parameters,serviceId,serviceRevision'||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!Number.isSafeInteger(input.serviceRevision)||input.serviceRevision<0||typeof input.serviceId!=='string'||!SERVICE_ID.test(input.serviceId)||typeof input.operationId!=='string'||!input.operationId||input.operationId.length>160||!isDataRecord(input.parameters)||JSON.stringify(input.parameters).length>65536)fail();
 return {...input};
}
export function parseServiceCatalog(input){
 if(!isDataRecord(input)||input.schemaVersion!==1||!Array.isArray(input.services)||input.services.length>4096)fail();
 return {schemaVersion:1,services:input.services.map(parseServiceView)};
}
export function parseServiceView(value){
 if(!isDataRecord(value)||typeof value.id!=='string'||!SERVICE_ID.test(value.id)||typeof value.runtimeId!=='string'||typeof value.label!=='string'||!['api','productivity','mcp','channel','tool'].includes(value.kind)||!['device','project'].includes(value.scope)||!['none','api-key','oauth'].includes(value.auth)||!SERVICE_STATES.includes(value.state)||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.enabled!=='boolean'||typeof value.credentialPresent!=='boolean'||!(value.connectionId===null||typeof value.connectionId==='string')||!(value.errorCode===null||typeof value.errorCode==='string')||!Array.isArray(value.resourceIds)||!Array.isArray(value.aliases)||!Array.isArray(value.operations)||value.operations.length>512)fail();
 for(const key of ['resourceIds','aliases'])if(value[key].some(item=>typeof item!=='string'||item.length>160))fail();
 for(const operation of value.operations){if(!isDataRecord(operation)||typeof operation.id!=='string'||typeof operation.label!=='string'||!['read_external','write_external'].includes(operation.effect)||!isDataRecord(operation.inputSchema))fail();}
 for(const key of ['endpointUrl','documentationUrl','getKeyUrl']){if(value[key]!==null&&value[key]!==undefined){let url;try{url=new URL(value[key]);}catch{fail();}if(url.protocol!=='https:'||url.username||url.password)fail();}}
 if(value.connections!==undefined&&(!Array.isArray(value.connections)||value.connections.length>128||value.connections.some(item=>!isDataRecord(item)||typeof item.id!=='string'||typeof item.label!=='string'||typeof item.enabled!=='boolean'||typeof item.credentialPresent!=='boolean')))fail();
 if(JSON.stringify(value).length>4*1024*1024)fail();
 return value;
}
