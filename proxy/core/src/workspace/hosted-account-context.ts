import { AsyncLocalStorage } from 'node:async_hooks';

// Account access tokens exist only for an authenticated mobility HTTP operation.
// They are never a local bearer, a provider key, an environment default or a vault entry.
const context = new AsyncLocalStorage<{ token?: string; active:boolean; revalidate?:()=>Promise<void> }>();
export function withHostedAccountToken<T>(token: string | undefined, operation: () => Promise<T>, revalidate?:()=>Promise<void>): Promise<T> {
  const valid = token !== undefined && token.length >= 8 && token.length <= 16000 && !/\s/.test(token) && !/^utk_/i.test(token);
  const scope={...(valid?{token}:{}),active:true,revalidate};
  return context.run(scope,async()=>{try{return await operation();}finally{scope.active=false;scope.token=undefined;}});
}
export async function requestHostedAccountToken(signal: AbortSignal): Promise<string | undefined> {
  const scope=context.getStore();if(signal.aborted||!scope?.active)return undefined;
  await scope.revalidate?.();
  return signal.aborted||!scope.active?undefined:scope.token;
}
/** Recheck a native link after remote IO, before its result can commit locally. */
export async function revalidateHostedAccountOperation(signal:AbortSignal):Promise<void>{
  if(!await requestHostedAccountToken(signal))throw Error('account_cancelled');
}
/** Local/browser work has no native binding; a linked operation keeps its guard. */
export async function revalidateHostedAccountBinding():Promise<void>{
  const scope=context.getStore();if(!scope?.revalidate)return;
  if(!scope.active)throw Error('account_cancelled');await scope.revalidate();
  if(!scope.active)throw Error('account_cancelled');
}
