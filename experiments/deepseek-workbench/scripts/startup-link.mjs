// Transient local launch credential: return to the native caller only, never log.
function nativeCookie(value){
 if(typeof value!=='string'||value.length>8192)return undefined;
 const parts=value.split(';').map(part=>part.trim()),pair=parts.shift(),at=pair?.indexOf('=')??-1;
 if(at<1)return undefined;
 const name=pair.slice(0,at),body=pair.slice(at+1),attributes=new Map();
 for(const part of parts){const index=part.indexOf('='),key=(index<0?part:part.slice(0,index)).toLowerCase();if(attributes.has(key))return undefined;attributes.set(key,index<0?true:part.slice(index+1))}
 const maxAge=Number(attributes.get('max-age'));
 if(!/^dsh-auth-[A-Za-z0-9_-]{20,128}$/.test(name)||!/^v1\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,128}$/.test(body)
  ||attributes.get('path')!=='/'||attributes.get('httponly')!==true||attributes.get('samesite')!=='Strict'
  ||attributes.has('secure')||attributes.has('domain')||!Number.isSafeInteger(maxAge)||maxAge<1||maxAge>10*366*86400
  ||typeof attributes.get('expires')!=='string'||!Number.isFinite(Date.parse(attributes.get('expires'))))return undefined;
 return {name,value:body,maxAgeSeconds:maxAge};
}
export async function authenticatedStartup(readLogs,{fetcher=fetch,attempts=150,delay=()=>new Promise(done=>setTimeout(done,200))}={}){
 for(let i=0;i<attempts;i++){
  const logs=await readLogs();
  const candidate=[...logs.matchAll(/http:\/\/127\.0\.0\.1:43180\/\?token=[A-Za-z0-9._~%-]+/g)].at(-1)?.[0];
  if(candidate){
   const url=new URL(candidate),pairs=[...url.searchParams];
   if(pairs.length===1&&pairs[0][0]==='token'&&/^[A-Za-z0-9._~-]{16,4096}$/.test(pairs[0][1])){
    try{const response=await fetcher(candidate,{redirect:'manual',signal:AbortSignal.timeout(1500)});
     const cookie=nativeCookie(response.headers.get('set-cookie'));const admitted=response.status===303&&response.headers.get('location')==='./'&&cookie!==undefined;await response.body?.cancel();if(admitted)return {url:candidate,cookie};
    }catch{}
   }
  }
  await delay();
 }
 throw Error('Authenticated laboratory startup timed out');
}
export async function authenticatedStartupLink(readLogs,options){return (await authenticatedStartup(readLogs,options)).url}
