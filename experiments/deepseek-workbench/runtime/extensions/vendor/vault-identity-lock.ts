import type {SecretStore} from './secret-store.ts';

/** Internal lease; authenticity and lifetime are checked by this module. */
export type VaultIdentityLease=object;
const queues=new WeakMap<SecretStore,Promise<unknown>>();
const leases=new WeakMap<VaultIdentityLease,{store:SecretStore;active:boolean}>();

/** One FIFO per existing vault owner; nesting requires an explicit live lease. */
export async function withVaultIdentityLock<T>(store:SecretStore,operation:(lease:VaultIdentityLease)=>Promise<T>,lease?:VaultIdentityLease):Promise<T>{
  if(lease!==undefined){const state=leases.get(lease);if(!state?.active||state.store!==store)throw Error('vault_identity_lease_invalid');return operation(lease);}
  const previous=queues.get(store)??Promise.resolve();
  const run=previous.catch(()=>undefined).then(async()=>{
    const token=Object.freeze({}),state={store,active:true};leases.set(token,state);
    try{return await operation(token);}finally{state.active=false;}
  });
  queues.set(store,run);
  try{return await run;}finally{if(queues.get(store)===run)queues.delete(store);}
}
