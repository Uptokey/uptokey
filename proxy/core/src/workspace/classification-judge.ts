/**
 * Small, non-authorizing semantic judgments with the caller's own TypeSafe profile (Jev): the terminal asks whether a
 * request looks destructive, whether a pending tool call fits the request, whether a compaction summary kept the
 * essentials. The core stays the single owner of the TypeSafe credential; the text is used for this call only and is
 * not stored. Answers never authorize an effect: W5 plans, consent and receipts are unchanged.
 */
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {performTypeSafeJudgment} from '../../../integracoes/api-instruments/src/typesafe-judgment.ts';

export interface JudgeProfiles {
  info(principal:string):Promise<{model:string;revision:number;enabled:boolean;configured:boolean}>;
  resolveCredential(principal:string,revision:number,signal:AbortSignal):Promise<string|undefined>;
}
export class JudgeError extends Error {
  readonly status:400|403|429|502|503;
  constructor(code:string,status:400|403|429|502|503){super(code);this.status=status;}
}
export const JUDGE_LIMITS={maxStateBytes:12_000,maxQuestions:6,maxQuestionBytes:6_000,timeoutMs:5_000,maxOutputBytes:32_768,maxInFlightPerPrincipal:4};
const QUESTION_ID=/^[a-z][a-z0-9_]{0,39}$/;
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value)??'','utf8');

type Parsed={state:unknown;questions:Record<string,{type:'noul'|'choice'|'score';instructions:unknown;criteria?:unknown}>};
function parse(input:unknown):Parsed{
  if(!isDataRecord(input)||Object.keys(input).some(key=>!['state','questions','processingPolicy','purpose'].includes(key)))throw new JudgeError('judge_input_invalid',400);
  if(input.processingPolicy!=='external_allowed')throw new JudgeError('judge_external_processing_denied',403);
  if(input.purpose!==undefined&&(typeof input.purpose!=='string'||!/^[a-z][a-z0-9_.-]{0,63}$/.test(input.purpose)))throw new JudgeError('judge_input_invalid',400);
  if(input.state===undefined||bytes(input.state)>JUDGE_LIMITS.maxStateBytes)throw new JudgeError('judge_state_invalid',400);
  if(!isDataRecord(input.questions))throw new JudgeError('judge_questions_invalid',400);
  const entries=Object.entries(input.questions);
  if(!entries.length||entries.length>JUDGE_LIMITS.maxQuestions)throw new JudgeError('judge_questions_invalid',400);
  const questions:Parsed['questions']={};
  for(const [id,question] of entries){
    if(!QUESTION_ID.test(id)||!isDataRecord(question)||!['noul','choice','score'].includes(String(question.type))||question.instructions===undefined||bytes(question)>JUDGE_LIMITS.maxQuestionBytes)throw new JudgeError('judge_questions_invalid',400);
    if(Object.keys(question).some(key=>!['type','instructions','criteria'].includes(key)))throw new JudgeError('judge_questions_invalid',400);
    if((question.type==='choice'||question.type==='score')&&question.criteria===undefined)throw new JudgeError('judge_questions_invalid',400);
    questions[id]={type:question.type as 'noul'|'choice'|'score',instructions:question.instructions,...(question.criteria!==undefined?{criteria:question.criteria}:{})};
  }
  return {state:input.state,questions};
}

function validAnswers(questions:Parsed['questions'],answers:unknown){
  if(!isDataRecord(answers))return false;
  const unit=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
  return Object.entries(questions).every(([id,question])=>{
    const answer=answers[id];
    if(!isDataRecord(answer)||answer.type!==question.type)return false;
    if(question.type==='noul')return unit(answer.noul);
    if(question.type==='choice')return typeof answer.choice==='string'&&(answer.confidence===undefined||unit(answer.confidence));
    return typeof answer.score==='number'&&Number.isFinite(answer.score);
  });
}

export class ClassificationJudge {
  private readonly inFlight=new Map<string,number>();
  private readonly profiles:JudgeProfiles|undefined;
  private readonly fetchFn?:typeof fetch;
  constructor(profiles:JudgeProfiles|undefined,fetchFn?:typeof fetch){this.profiles=profiles;this.fetchFn=fetchFn;}

  async judge(principal:string,input:unknown,signal:AbortSignal){
    const request=parse(input);
    if(!this.profiles)throw new JudgeError('classifier_unavailable',503);
    const profile=await this.profiles.info(principal);
    if(!profile.configured||!profile.enabled)throw new JudgeError('classifier_disabled',503);
    const running=this.inFlight.get(principal)??0;
    if(running>=JUDGE_LIMITS.maxInFlightPerPrincipal)throw new JudgeError('judge_busy',429);
    this.inFlight.set(principal,running+1);
    try{
      const bounded=AbortSignal.any([signal,AbortSignal.timeout(JUDGE_LIMITS.timeoutMs)]);
      const credential=await this.profiles.resolveCredential(principal,profile.revision,bounded);
      if(!credential)throw new JudgeError('classifier_disabled',503);
      let result:{model?:string;answers?:unknown;usage?:{input_tokens?:number;output_tokens?:number}};
      try{
        result=await performTypeSafeJudgment({credential,model:profile.model,state:request.state as never,questions:request.questions as never,timeoutMs:JUDGE_LIMITS.timeoutMs,maxBytes:JUDGE_LIMITS.maxOutputBytes,signal:bounded,...(this.fetchFn?{fetchFn:this.fetchFn}:{}),onDispatch:()=>undefined}) as typeof result;
      }catch(error){
        if(error instanceof JudgeError)throw error;
        throw new JudgeError(bounded.aborted?'judge_timeout':'judge_upstream_failed',502);
      }
      if(!validAnswers(request.questions,result.answers))throw new JudgeError('judge_output_invalid',502);
      return {model:typeof result.model==='string'?result.model:profile.model,answers:result.answers,usage:result.usage?{inputTokens:Number(result.usage.input_tokens??0),outputTokens:Number(result.usage.output_tokens??0)}:null,authorizesAction:false as const};
    }finally{
      const now=(this.inFlight.get(principal)??1)-1;
      if(now>0)this.inFlight.set(principal,now);else this.inFlight.delete(principal);
    }
  }
}
