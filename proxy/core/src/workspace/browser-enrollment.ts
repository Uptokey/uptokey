import {createHash} from 'node:crypto';
export const PUBLIC_PWA_ORIGIN = 'https://app.uptokey.com';
export const isPublicPwaOrigin = (origin:unknown):origin is string => origin === PUBLIC_PWA_ORIGIN;
export const isPairedBrowserOrigin = (origin:unknown):origin is string => typeof origin === 'string' && (isPublicPwaOrigin(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
/** Existing local PWA admission or explicit public PWA approval, never a name/admin grant. */
export function isApprovedPwaRegistration(registration:{audience:unknown;enrolledVia:unknown;browserOrigin?:unknown}|undefined,origin?:string):boolean {
  if(registration?.audience!=='pwa')return false;
  if(registration.enrolledVia==='browser-session')return registration.browserOrigin===undefined&&!isPublicPwaOrigin(origin);
  return registration.enrolledVia==='pairing'&&isPublicPwaOrigin(registration.browserOrigin)&&(origin===undefined||origin===registration.browserOrigin);
}
/** The index is public device enrollment metadata, not a credential or account. */
export function browserEnrollmentKey(origin:string,key:{kty:string;crv:string;x:string;y:string}):string {
  if(!isPairedBrowserOrigin(origin))throw Error('browser_origin_invalid');
  const namespace=isPublicPwaOrigin(origin)?'local:workspace-public-browser:':'local:workspace-extension:';
  return namespace+createHash('sha256').update(JSON.stringify([origin,{kty:key.kty,crv:key.crv,x:key.x,y:key.y}])).digest('hex');
}
