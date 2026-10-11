import {createHash} from 'node:crypto';
/** The index is public device enrollment metadata, not a credential or account. */
export function browserEnrollmentKey(origin:string,key:{kty:string;crv:string;x:string;y:string}):string {
  if(!new RegExp('^chrome-extension://[a-p]{32}$').test(origin))throw Error('browser_origin_invalid');
  return 'local:workspace-extension:'+createHash('sha256').update(JSON.stringify([origin,{kty:key.kty,crv:key.crv,x:key.x,y:key.y}])).digest('hex');
}
