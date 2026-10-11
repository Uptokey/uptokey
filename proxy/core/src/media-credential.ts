import type {SecretStore} from './secret-store.ts';

/** Existing account authority, never a copy of its secret. */
export interface MediaCredentialIdentity {
 credentialRef:string;
 endpointOrigin:string;
 current():boolean;
 revalidate?():Promise<void>;
}
export async function readMediaCredential(secrets:Pick<SecretStore,'get'>,identity:MediaCredentialIdentity|undefined,current:()=>void):Promise<string>{
 current();await identity?.revalidate?.();current();
 const secret=await secrets.get(identity?.credentialRef??'provider:custom');
 await identity?.revalidate?.();current();
 if(!secret)throw Error('media_connection_changed');
 return secret;
}
export function guardedMediaFetch(identity:MediaCredentialIdentity|undefined,current:()=>void,fetchImpl:typeof fetch):typeof fetch{
 return ((input:RequestInfo|URL,init?:RequestInit)=>{
  current();init?.signal?.throwIfAborted();
  return (async()=>{
   await identity?.revalidate?.();current();init?.signal?.throwIfAborted();
   const response=await fetchImpl(input,init);
   try{await identity?.revalidate?.();current();init?.signal?.throwIfAborted();}
   catch(error){await response.body?.cancel();throw error;}
   return response;
  })();
 }) as typeof fetch;
}
