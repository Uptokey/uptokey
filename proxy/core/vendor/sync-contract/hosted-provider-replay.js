const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const name=/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,id=/^[A-Za-z0-9_.:-]{1,200}$/;
/** Bounded native Vertex parts, carried only as adapter replay metadata.
 * No credentials, endpoint, permissions or tool execution are represented. */
export function parseHostedProviderReplay(value,content,calls,allowAdditionalText=false) {
  if(value===undefined)return undefined;
  try {
    if(!record(value)||Object.keys(value).some(k=>!['kind','parts','callIds'].includes(k))||value.kind!=='vertex-content-v1'
      ||!Array.isArray(value.parts)||!value.parts.length||value.parts.length>32||!Array.isArray(value.callIds)||value.callIds.length>8
      ||value.callIds.some(v=>typeof v!=='string'||!id.test(v))||new Set(value.callIds).size!==value.callIds.length
      ||new TextEncoder().encode(JSON.stringify(value)).byteLength>128000)return null;
    const parts=JSON.parse(JSON.stringify(value.parts));let text='',index=0;
    for(const part of parts){
      if(!record(part)||Object.keys(part).some(k=>!['text','thought','thoughtSignature','functionCall'].includes(k))
        ||(part.thought!==undefined&&typeof part.thought!=='boolean')
        ||(part.thoughtSignature!==undefined&&(typeof part.thoughtSignature!=='string'||!part.thoughtSignature.length||part.thoughtSignature.length>65536||!/^[A-Za-z0-9+/=_-]+$/.test(part.thoughtSignature))))return null;
      if(part.functionCall!==undefined){
        const fn=part.functionCall,call=calls?.[index];
        if(!record(fn)||Object.keys(fn).some(k=>!['name','args','id'].includes(k))||typeof fn.name!=='string'||!name.test(fn.name)||!record(fn.args)
          ||(fn.id!==undefined&&(typeof fn.id!=='string'||!id.test(fn.id)))||part.text!==undefined||part.thought===true
          ||!call||call.id!==value.callIds[index]||call.name!==fn.name||call.arguments!==JSON.stringify(fn.args))return null;
        index++;
      }else{
        if(typeof part.text!=='string')return null;
        if(part.thought!==true)text+=part.text;
      }
    }
    if(index!==value.callIds.length||index!==(calls?.length??0)||(text!==content&&!(allowAdditionalText&&typeof content==='string'&&content.startsWith(text))))return null;
    return {kind:'vertex-content-v1',parts,callIds:[...value.callIds]};
  }catch{return null;}
}
