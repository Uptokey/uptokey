import {projectHostedCatalog} from '../runtime/contracts/hosted-catalog.js';
import {accountState} from './account-client.mjs';

// Resolve only the already-selected account. Never adopt another local account.
export function currentHostedAccount(value, now=Date.now()) {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0 ||
      !Array.isArray(value.accounts) || value.accounts.length > 256 ||
      !(value.currentAccountRef === null || /^acc_[a-f0-9]{64}$/.test(value.currentAccountRef ?? '')) ||
      !(value.currentOwned === null || typeof value.currentOwned === 'boolean') ||
      (value.currentAccountRef === null) !== (value.currentOwned === null)) throw Error('account_response_invalid');
  const seen = new Set();
  let current;
  for (const entry of value.accounts) {
    if (typeof entry?.accountRef !== 'string' || !/^acc_[a-f0-9]{64}$/.test(entry.accountRef) ||
        seen.has(entry.accountRef) || typeof entry.owned !== 'boolean' ||
        !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= 0 || !accountState(entry.session).authenticated) throw Error('account_response_invalid');
    seen.add(entry.accountRef);
    if (entry.accountRef === value.currentAccountRef) current = entry;
  }
  if (value.currentAccountRef === null) return null;
  if (!current || current.owned !== value.currentOwned) throw Error('account_response_invalid');
  if (current.expiresAt <= now) throw Error('account_reauthentication_required');
  return {accountRef:current.accountRef, revision:value.revision};
}

export async function discoverHostedCatalog({token, fetcher=fetch, signal}={}) {
  if (typeof token !== 'string' || !/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(token)) throw Error('account_pairing_required');
  const deadline=AbortSignal.timeout(45000);
  const activeSignal=signal ? AbortSignal.any([signal,deadline]) : deadline;
  async function request(path, body) {
    const response=await fetcher('http://127.0.0.1:21435/local/account/'+path, {
      method:body ? 'POST' : 'GET', headers:{authorization:'Bearer '+token, ...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}), redirect:'error', signal:activeSignal,
    });
    if (!response.ok || !/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type')??'')) {
      await response.body?.cancel();
      throw Error(response.status===401?'account_reauthentication_required':response.status===429?'account_rate_limited':'hosted_catalog_unavailable');
    }
    const reader=response.body?.getReader(); if(!reader) throw Error('account_response_invalid');
    let size=0; const chunks=[];
    try { for(;;) { const next=await reader.read(); if(next.done)break; size+=next.value.length;
      if(size>262144)throw Error('account_response_invalid'); chunks.push(Buffer.from(next.value));
    }} finally {await reader.cancel().catch(()=>{}); reader.releaseLock();}
    try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw Error('account_response_invalid');}
  }
  const identity=currentHostedAccount(await request('available'));
  if(!identity)return {state:'signed_out',models:[]};
  const row=await request('hosted',{...identity,operation:'models',payload:{}});
  if(row?.accountRef!==identity.accountRef || row.revision!==identity.revision)throw Error('account_share_conflict');
  const catalog=projectHostedCatalog(row);
  if(typeof row.executionEnabled!=='boolean')throw Error('hosted_catalog_invalid');
  const after=currentHostedAccount(await request('available'));
  if(after?.accountRef!==identity.accountRef || after.revision!==identity.revision)throw Error('account_share_conflict');
  // Account binding stays in host memory. Public projection contains no profile or tokens.
  return {state:row.executionEnabled?'available':'disabled',...identity,...catalog};
}
