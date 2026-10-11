/**
 * Shared network destination policy for every outbound read (E2-12 public web fetch, E2-09 provider
 * content download). One implementation classifies special-use names and private/metadata addresses,
 * and resolves the hostname so a public name pointing at an internal address is refused before connecting.
 */
import {lookup as dnsLookup} from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {Readable} from 'node:stream';
import {byteStream} from './portable-streams.ts';

export type HostResolver=(hostname:string)=>Promise<readonly {address:string;family:number}[]>;
export const defaultHostResolver:HostResolver=hostname=>dnsLookup(hostname,{all:true,verbatim:true});

export class NetworkPolicyError extends Error {readonly code:'network_host_denied'|'network_dns_unavailable';constructor(code:'network_host_denied'|'network_dns_unavailable'){super(code);this.code=code;}}

/** Special-use names that must never be resolved even before DNS. */
export function isDeniedHostname(hostname:string):boolean {
 const value=hostname.replace(/^\[|\]$/g,'').toLowerCase();
 return value==='localhost'||value.endsWith('.localhost')||value.endsWith('.local')||value.endsWith('.internal')||
  value.endsWith('.home.arpa')||value==='0.0.0.0'||value==='::';
}

export function isPrivateAddress(address:string):boolean {
 const value=address.toLowerCase().replace(/^\[|\]$/g,'');
 if(!ipaddr.isValid(value))return value.includes(':')||/^[\d.]+$/.test(value);
 return ipaddr.process(value).range()!=='unicast';
}

/** Each socket uses only these approved DNS answers; Host and TLS SNI retain the URL hostname. */
export function fetchPinnedPublic(url:string,init:RequestInit,addresses:readonly {address:string;family:number}[]):Promise<Response>{
 const target=new URL(url);
 if(!['http:','https:'].includes(target.protocol)||target.username||target.password||init.method&&init.method!=='GET'||init.body||!addresses.length||addresses.some(item=>!ipaddr.isValid(item.address)||isPrivateAddress(item.address)))return Promise.reject(new NetworkPolicyError('network_host_denied'));
 return new Promise((resolve,reject)=>{
  const headers=Object.fromEntries(new Headers(init.headers));headers['accept-encoding']='identity';
  const request=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{
   method:'GET',agent:false,headers,maxHeaderSize:16_384,signal:init.signal??undefined,
   lookup:(_host,options,done)=>{
    const family=typeof options==='object'?options.family:options;
    const matching=addresses.filter(item=>!family||family===item.family);
    if(!matching.length){done(new Error('network_dns_unavailable'),'',0);return;}
    if(typeof options==='object'&&options.all)done(null,matching as never);
    else done(null,matching[0]!.address,matching[0]!.family);
   },
  },response=>{
   const headers=new Headers();for(const [key,value] of Object.entries(response.headers))if(value!==undefined)for(const item of Array.isArray(value)?value:[value])headers.append(key,item);
   const status=response.statusCode??502;
   if(status===204||status===205||status===304){response.resume();resolve(new Response(null,{status,headers}));return;}
   try{resolve(new Response(byteStream(Readable.toWeb(response).getReader()),{status,headers}));}catch(error){response.destroy();reject(error);}
  });
  request.once('error',reject);request.end();
 });
}

/** Resolves every answer and refuses the host when any is private, metadata or special-use. */
export async function assertPublicHost(hostname:string,resolve:HostResolver=defaultHostResolver):Promise<readonly {address:string;family:number}[]> {
 const value=hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(isDeniedHostname(value)||isPrivateAddress(value))throw new NetworkPolicyError('network_host_denied');
 let resolved:readonly {address:string;family:number}[];
 try{resolved=await resolve(value);}catch{throw new NetworkPolicyError('network_dns_unavailable');}
 if(!resolved.length)throw new NetworkPolicyError('network_dns_unavailable');
 if(resolved.some(item=>!ipaddr.isValid(item.address)||isPrivateAddress(item.address)))throw new NetworkPolicyError('network_host_denied');
 return resolved;
}
