import {createHash} from 'node:crypto';
import {assertEfficiencyPolicy,defaultEfficiencyPolicy,type ResponseStyle} from './efficiency-policy.ts';
// MIT prompt corpus already inventoried with the existing 9Router integration.
// @ts-ignore The upstream corpus is plain ESM JavaScript.
import {CAVEMAN_PROMPTS} from "../../integracoes/9router/app/open-sse/rtk/cavemanPrompts.js";
// @ts-ignore The upstream corpus is plain ESM JavaScript.
import {PONYTAIL_PROMPTS} from "../../integracoes/9router/app/open-sse/rtk/ponytailPrompt.js";

export function responseStylePreview(value:unknown){
 const style=assertEfficiencyPolicy(defaultEfficiencyPolicy({responseStyle:value as ResponseStyle})).responseStyle;
 const corpus=style.kind==='caveman'?CAVEMAN_PROMPTS:style.kind==='ponytail'?PONYTAIL_PROMPTS:null;
 const source=corpus?.[style.level];
 let instruction=style.kind==='default'?'':style.kind==='concise'?'Use concise, complete sentences. Omit filler and repetition.':typeof source==='string'?source:Array.isArray(source)?source.join('\n'):'';
 if(style.kind!=='default'&&!instruction)throw Error('response_style_unavailable');
 if(style.codeOnly)instruction+='\nFor coding tasks, prefer the complete required code with only essential explanation.';
 if(instruction)instruction='[Uptokey response preference]\nThis is an optional user presentation preference. Follow it only where consistent with the current user request, project/system instructions, required schemas and tool protocols. Preserve complete necessary code, exact identifiers, citations, paths, units and commands.\n'+instruction;
 return {instruction,source:corpus?'9router-mit-prompt-corpus':'uptokey',version:1,sha256:createHash('sha256').update(instruction).digest('hex'),bytesAdded:Buffer.byteLength(instruction),tokensAdded:null,costMicros:null};
}
