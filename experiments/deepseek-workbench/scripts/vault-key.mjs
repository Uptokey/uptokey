import {randomBytes,timingSafeEqual} from 'node:crypto';

const valid=key=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key);
const equal=(a,b)=>timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
// Both stores belong exclusively to this laboratory. Never rotate an existing key.
export function reconcileVaultKey({readNative,writeNative,readRuntime,writeRuntime,canInitialize}){
 let native=readNative(),runtime=readRuntime();
 if(native!=null&&!valid(native))throw Error('vault_native_key_invalid');
 if(runtime!=null&&!valid(runtime))throw Error('vault_runtime_key_invalid');
 if(native&&runtime){
  if(!equal(native,runtime))throw Error('vault_key_identity_mismatch');
  return {state:'verified',keyDisplayed:false};
 }
 if(runtime){
  writeNative(runtime);
  native=readNative();
  if(!valid(native)||!equal(native,runtime))throw Error('vault_native_write_unverified');
  return {state:'protected-existing-key',keyDisplayed:false};
 }
 if(native){
  writeRuntime(native);
  runtime=readRuntime();
  if(!valid(runtime)||!equal(native,runtime))throw Error('vault_runtime_write_unverified');
  return {state:'restored-runtime-key',keyDisplayed:false};
 }
 if(!canInitialize())throw Error('vault_key_missing_restore_required');
 const bytes=randomBytes(32);
 try{
  const key=bytes.toString('hex');
  writeNative(key);
  native=readNative();
  if(!valid(native)||!equal(native,key))throw Error('vault_native_write_unverified');
  writeRuntime(key);
  runtime=readRuntime();
  if(!valid(runtime)||!equal(runtime,key))throw Error('vault_runtime_write_unverified');
  return {state:'created',keyDisplayed:false};
 }finally{bytes.fill(0)}
}
