import { isDataRecord, projectDataArray } from './plain-data.js';
import { canonicalJson } from './canonical.js';

/** Initial browser profile: controlled loopback pages only. Parsing does not authorize navigation. */
export const BROWSER_READ_CONTRACT_VERSION = 1;
export function parseBrowserReadRequest(input) {
  const invalid=()=>{throw new Error('browser_read_invalid');};
  if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='schemaVersion,url'||
      input.schemaVersion!==BROWSER_READ_CONTRACT_VERSION||typeof input.url!=='string'||input.url.length>2048)invalid();
  let url;
  try{url=new URL(input.url);}catch{invalid();}
  if(url.href!==input.url||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||
      url.username||url.password||url.search||url.hash)invalid();
  return Object.freeze({schemaVersion:BROWSER_READ_CONTRACT_VERSION,url:input.url});
}
export function canonicalBrowserReadPayload(input) {
  return canonicalJson(parseBrowserReadRequest(input));
}

/** Explicit text-field fill. This envelope never authorizes submission or arbitrary code. */
export const BROWSER_FILL_CONTRACT_VERSION = 1;
export function parseBrowserFillRequest(input) {
  const invalid=()=>{throw new Error('browser_fill_invalid');};
  if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='fields,schemaVersion,url'||input.schemaVersion!==BROWSER_FILL_CONTRACT_VERSION)invalid();
  let target;try{target=parseBrowserReadRequest({schemaVersion:1,url:input.url});}catch{invalid();}
  const fields=projectDataArray(input.fields,8);if(!fields?.length)invalid();
  const labels=new Set();
  const clean=fields.map(field=>{
    if(!isDataRecord(field)||Object.keys(field).sort().join(',')!=='label,value'||
      typeof field.label!=='string'||!field.label.trim()||field.label.length>200||
      typeof field.value!=='string'||field.value.length>2000||labels.has(field.label))invalid();
    for(const text of [field.label,field.value])if(new TextDecoder().decode(new TextEncoder().encode(text))!==text||text.includes('\0'))invalid();
    labels.add(field.label);return Object.freeze({label:field.label,value:field.value});
  });
  const result={schemaVersion:BROWSER_FILL_CONTRACT_VERSION,url:target.url,fields:Object.freeze(clean)};
  if(new TextEncoder().encode(canonicalJson(result)).byteLength>8192)invalid();
  return Object.freeze(result);
}
export function canonicalBrowserFillPayload(input){return canonicalJson(parseBrowserFillRequest(input));}
