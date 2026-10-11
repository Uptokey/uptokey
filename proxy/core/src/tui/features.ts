import { t } from "./i18n.ts";
/** Production orchestration for the TUI's progressively disclosed capabilities.
 * The core remains the owner of plans, consent, dispatch, artifacts and budgets.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import type { TuiController } from './controller.ts';
import { TuiCapabilityActions, type MediaKind, type ComparisonInput, type ComparisonResult } from './capability-actions.ts';
import { WorkspaceServiceError, parseWorkspaceView, type WorkspaceView } from './workspace.ts';
import { DebuggerClient, prepareNodeDebugSession } from './debugger.ts';
import { AudioCapture, pcmWav, PcmPlayer, ffmpegPath } from './audio-io.ts';
import { TuiRealtimeVoice, loadVoiceProfile, voiceSessionFromProfile } from './voice.ts';
import { sanitizeForDisplay } from './sanitize.ts';
import type { FilesystemReadTool } from '@uptokey/sync-contract/filesystem';

export interface FeatureReview { id:string; title:string; body:string }
export class TuiFeatures {
  readonly actions: TuiCapabilityActions;
  review:FeatureReview|null=null;
  busy:string|null=null;
  audio:{active:boolean;durationMs:number;rms:number}={active:false,durationMs:0,rms:0};
  debugger:DebuggerClient|null=null;
  comparison:ComparisonResult|null=null;
  voice:TuiRealtimeVoice|null=null;
  private readonly player=new PcmPlayer();
  private controller:AbortController|null=null;
  private pending:{id:string;resolve:(accepted:boolean)=>void}|null=null;
  private readonly capture=new AudioCapture();
  private disposed=false;
  private readonly host:TuiController;
  private readonly ensureConversation:()=>Promise<string>;
  constructor(host:TuiController,ensureConversation:()=>Promise<string>){
    this.host=host;this.ensureConversation=ensureConversation;
    this.actions=new TuiCapabilityActions({
      client:host.client,workspace:host.workspace,
      context:()=>({projectId:host.view.binding?.projectId??'',rootBindingId:host.view.binding?.rootBindingId,rootPath:host.view.binding?.rootPath,
        conversationId:host.state.activeConversation?.id,model:host.state.selectedModel,storagePolicy:host.state.storagePolicy,processingPolicy:host.state.processingPolicy}),
      approveAndRun:(view,summary,signal)=>this.executePlan(view,summary,signal),
      approveComparison:(plan,summary,signal)=>this.confirm(summary,`Modelos e tarefas:\n${plan.members.map(m=>`${m.modelId} · ${m.connectionId}\n${m.task}`).join('\n\n')}\n\nLimites: ${JSON.stringify(plan.limits)}\nPlano: ${plan.id}\n${plan.digest}`,signal),
      sign:nonce=>{if(!host.signer)throw new Error('native_identity_unavailable');return host.signer(nonce);},
    });
    this.capture.on('level',(state:{rms:number;durationMs:number})=>{this.audio={active:true,...state};this.change();});
    this.capture.on('stopped',()=>{this.audio={...this.audio,active:false,rms:0};this.change();});
    this.capture.on('failure',()=>{this.audio={active:false,durationMs:0,rms:0};host.notice('error',t('n_o_foi_poss_vel_capturar_udio'));this.change();});
  }
  private change():void{if(!this.disposed)this.host.emit('change');}
  confirm(title:string,body:string,signal?:AbortSignal):Promise<boolean>{
    signal?.throwIfAborted();
    if(this.pending)throw new Error('review_already_pending');
    const id=randomUUID();
    this.review={id,title:sanitizeForDisplay(title),body:sanitizeForDisplay(body)};
    const result=new Promise<boolean>(resolve=>{this.pending={id,resolve};});
    const abort=()=>this.respond(id,false);
    signal?.addEventListener('abort',abort,{once:true});
    this.change();
    return result.finally(()=>signal?.removeEventListener('abort',abort));
  }
  respond(id:string,accepted:boolean):void{
    if(this.pending?.id!==id)return;
    const pending=this.pending;this.pending=null;this.review=null;pending.resolve(accepted);this.change();
  }
  cancel():boolean{
    let handled=false;
    if(this.pending){this.respond(this.pending.id,false);handled=true;}
    if(this.voice&&!['idle','closed','failed'].includes(this.voice.snapshot.state)){void this.voice.stop('user_cancelled');this.player.stop();handled=true;}
    if(this.capture.active||this.capture.hasRecording){void this.capture.cancel();this.audio={active:false,durationMs:0,rms:0};this.change();handled=true;}
    if(this.controller){this.controller.abort(new Error('operation_cancelled'));handled=true;}
    return handled;
  }
  dispose():void{this.disposed=true;this.cancel();void this.capture.cancel();void this.voice?.dispose();this.player.stop();void this.debugger?.dispose();this.comparison=null;}
  async run<T>(title:string,action:(signal:AbortSignal)=>Promise<T>):Promise<T|undefined>{
    if(this.controller||this.host.busy){this.host.notice('info',t('conclua_ou_cancele_a_opera_o_a'));return;}
    const abort=new AbortController();this.controller=abort;this.busy=title;this.change();
    try{
      if(!this.host.view.binding)throw new Error('project_required');
      await this.ensureConversation();abort.signal.throwIfAborted();
      return await action(abort.signal);
    }catch(error){
      const code=error instanceof Error?error.message:'operation_failed';
      this.host.notice(abort.signal.aborted?'info':'error',abort.signal.aborted?t('feat_interrupted'):`${title}: ${sanitizeForDisplay(code)}.`);
    }finally{if(this.controller===abort)this.controller=null;this.busy=null;this.change();}
  }
  private async executePlan(view:WorkspaceView,summary:string,signal?:AbortSignal):Promise<WorkspaceView>{
    const binding=this.host.view.binding,sign=this.host.signer,plan=view.plan;
    const conversationId=this.host.state.activeConversation?.id;
    if(!binding||!sign||!plan||!conversationId||view.projectId!==binding.projectId)throw new Error('plan_identity_missing');
    const snapshot={projectId:binding.projectId,rootBindingId:binding.rootBindingId,conversationId,storagePolicy:this.host.state.storagePolicy,processingPolicy:this.host.state.processingPolicy};
    const body=`${summary}\n\n${plan.steps.map(step=>`${step.capabilityId}\n${JSON.stringify(step.arguments,null,2)}`).join('\n\n')}\n${t('feat_plan_label')} ${plan.id}\nDigest ${plan.digest}`;
    if(!await this.confirm(summary,body,signal))throw new Error('operation_declined');
    signal?.throwIfAborted();
    if(this.host.view.binding?.projectId!==snapshot.projectId||this.host.view.binding.rootBindingId!==snapshot.rootBindingId||this.host.state.activeConversation?.id!==snapshot.conversationId||this.host.state.storagePolicy!==snapshot.storagePolicy||this.host.state.processingPolicy!==snapshot.processingPolicy)throw new Error('plan_context_changed');
    const intention=await this.host.conversations.appendIntention(conversationId,t('feat_intention_approve',{summary}),`tui_cap_${plan.id}`);
    const requestId=randomUUID();let runId:string|undefined;
    const cancel=()=>{if(runId)void this.host.workspace.cancelRun(binding.projectId,runId).catch(()=>this.host.notice('warning',t('cancelamento_ainda_n_o_confirm')));};
    signal?.addEventListener('abort',cancel,{once:true});
    try{
      const admitted=await this.host.workspace.approveAndStart(binding.projectId,{planId:plan.id,planDigest:plan.digest,requestId},sign,signal,{conversationId,requestId:intention.requestId});
      runId=admitted.run?.id;if(!runId)throw new WorkspaceServiceError('run_not_admitted');
      if(signal?.aborted){cancel();signal.throwIfAborted();}
      const settled=await this.host.workspace.waitForSettledRun(binding.projectId,{planId:plan.id,requestId,runId},{signal,timeoutMs:330000});
      const receipt=settled.receipts.find(r=>r.runId===runId&&r.status==='succeeded');
      await this.host.conversations.linkRun(conversationId,{messageId:intention.messageId,requestId:intention.requestId,runId,projectId:binding.projectId,modelId:this.host.state.selectedModel||'auto',state:settled.run?.status??'unknown'});
      // The failed receipt carries the concrete cause (e.g. voice_connection_unavailable); a bare run status hid it.
      const failed=settled.receipts.find(r=>r.runId===runId&&r.status==='failed'&&r.errorCode);
      if(settled.run?.status!=='succeeded'||!receipt)throw new WorkspaceServiceError(failed?.errorCode??`run_${settled.run?.status??'unknown'}`);
      await this.host.conversations.appendRunResult(conversationId,intention.messageId,t('feat_capability_done',{summary,run:runId,receipt:receipt.id,artifacts:receipt.outputArtifactRefs.join(', ')}),`tui_cap_result_${runId}`);
      this.host.notice('info',t('feat_receipt_notice',{summary,receipt:receipt.id.slice(0,8)}));
      await this.host.refreshArtifacts();return settled;
    }finally{signal?.removeEventListener('abort',cancel);}
  }
  async media(kind:MediaKind,text:string):Promise<void>{
    await this.run(kind==='image'?t('feat_media_image'):kind==='video'?t('feat_media_video'):kind==='speech'?t('feat_media_speech'):t('feat_media_other'),async signal=>{
      const input=kind==='speech'?{input:text}:kind==='embeddings'?{inputs:[{kind:'text',text}]}:{prompt:text};
      await this.actions.runMedia(kind,input,signal);
    });
  }
  async transcribe(path:string):Promise<void>{await this.run(t('feat_title_transcribe'),async signal=>{const result=await this.actions.transcribeFile(path,{},signal);if(result.transcript)this.host.emit('draft',result.transcript);});}
  async transcriptionSetup(arg:string):Promise<void>{await this.run(t('feat_transcription_setup'),async signal=>{
    const info=await this.actions.mediaConfiguration('transcription',signal);
    const [model,endpoint]=arg.trim().split(/\s+/).filter(Boolean);
    if(!model){
      const profile=info.profile as {model?:string;endpoint?:string}|null;
      this.host.notice('info',info.configured&&profile?t('transcription_state_configured',{model:profile.model??'',endpoint:profile.endpoint??'',state:info.available?t('transcription_available'):t('transcription_unavailable')}):t('transcription_state_missing',{connections:info.connections.map(c=>c.label).join(', ')||'—'}));
      return;
    }
    if(!endpoint)throw new WorkspaceServiceError('transcription_endpoint_required',400);
    let origin:string;try{origin=new URL(endpoint).origin;}catch{throw new WorkspaceServiceError('transcription_endpoint_invalid',400);}
    // The connection is the saved account whose endpoint has this origin; never chosen by name or guessed.
    const matches=info.connections.filter(c=>c.endpointOrigin===origin);
    if(matches.length!==1)throw new WorkspaceServiceError(matches.length?'transcription_connection_ambiguous':'transcription_connection_missing',409);
    const connection=matches[0]!;
    const result=await this.actions.configureMedia('transcription',{expectedRevision:info.profileRevision,connectionId:connection.id,connectionRevision:connection.revision,model,endpoint,...(connection.id!=='custom'&&connection.providerId?{providerId:connection.providerId}:{})},signal);
    this.host.notice('info',t('transcription_configured',{model,connection:connection.label,state:result.available?t('transcription_available'):t('transcription_unavailable')}));
  });}
  /** /voice-setup [model]: shows the live voice state or selects the saved OpenAI connection and the realtime model. */
  async voiceSetup(arg:string):Promise<void>{await this.run(t('feat_voice_setup'),async signal=>{
    const info=await this.actions.voiceProfile(signal);
    const model=arg.trim().split(/\s+/).filter(Boolean)[0];
    if(!model){
      this.host.notice('info',info.configured?t('voice_state_configured',{model:info.model}):t('voice_state_missing',{connections:info.connections.map(c=>c.label).join(', ')||'—'}));
      return;
    }
    // The only connection that can serve OpenAI Realtime; several saved OpenAI accounts are an explicit choice.
    if(info.connections.length!==1)throw new WorkspaceServiceError(info.connections.length?'voice_connection_ambiguous':'voice_connection_missing',409);
    const connection=info.connections[0]!;
    const result=await this.actions.configureVoice({connectionId:connection.id,expectedRevision:info.profileRevision,model},signal);
    this.host.notice('info',t('voice_configured',{model,connection:connection.label,state:result.configured?t('transcription_available'):t('transcription_unavailable')}));
  });}
  async microphone():Promise<void>{
    if(this.capture.active||this.capture.hasRecording){
      const pcm=await this.capture.stop();this.audio={active:false,durationMs:0,rms:0};this.change();
      if(!pcm.length)return;
      const wav=pcmWav(pcm);pcm.fill(0);
      try{await this.run(t('feat_title_transcribe_mic'),async signal=>{const result=await this.actions.transcribeAudio(wav,'audio/wav',{},signal);if(result.transcript)this.host.emit('draft',result.transcript);});}
      finally{wav.fill(0);}return;
    }
    if(this.host.state.storagePolicy==='temporary'){this.host.notice('info',t('a_transcri_o_usa_artefatos_loc'));return;}
    if(!ffmpegPath()){this.host.notice('info',t('captura_indispon_vel_instale_o'));return;}
    if(this.host.busy)return;
    try{await this.capture.start();this.audio={active:true,durationMs:0,rms:0};this.change();}
    catch{this.host.notice('error',t('microfone_indispon_vel_confira'));}
  }
  async startVoice():Promise<void>{
    if(this.voice&&this.voice.snapshot.state==='active'){this.host.emit('voice');return;}
    await this.run(t('feat_title_voice'),async signal=>{
      if(this.host.state.storagePolicy!=='local')throw new Error('operation_blocked_temporary_session');
      if(this.host.state.processingPolicy!=='external_allowed')throw new Error('capability_external_processing_required');
      if(!ffmpegPath())throw new Error('native_microphone_component_missing');
      const binding=this.host.view.binding!;
      const conversationId=this.host.state.activeConversation?.id;
      const current=()=>{signal.throwIfAborted();if(this.host.view.binding?.rootBindingId!==binding.rootBindingId||this.host.state.activeConversation?.id!==conversationId||this.host.state.storagePolicy!=='local'||this.host.state.processingPolicy!=='external_allowed')throw new Error('voice_context_changed');};
      const profile=await loadVoiceProfile(this.host.client,signal);current();
      await this.voice?.dispose();this.player.stop();
      const voice=new TuiRealtimeVoice({client:this.host.client,projectId:binding.projectId,
        playback:(pcm,playSignal)=>this.player.play(pcm,playSignal),
        authorize:async(session,voiceSignal)=>{
          current();const view=await this.host.workspace.refresh(binding.projectId,voiceSignal);
          const response=await this.host.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(binding.projectId)}/voice-plans`,{method:'POST',body:JSON.stringify({expectedRevision:view.revision,session}),signal:voiceSignal});
          if(!response.ok)throw new Error(`voice_plan_failed_${response.status}`);
          const prepared=parseWorkspaceView(await response.json());current();
          const settled=await this.executePlan(prepared,t('feat_title_voice_start'),voiceSignal);current();
          if(!settled.artifact)throw new Error('voice_receipt_missing');
          const receipt=settled.receipts.find(item=>item.runId===settled.run?.id&&item.status==='succeeded'&&item.outputArtifactRefs.includes(settled.artifact!.id));
          if(!receipt)throw new Error('voice_artifact_unbound');
          const output:unknown=JSON.parse(await this.host.workspace.readArtifact(binding.projectId,settled.artifact.id,voiceSignal));
          if(!output||typeof output!=='object'||!('sessionId' in output)||typeof output.sessionId!=='string')throw new Error('voice_session_reference_invalid');
          return {sessionId:output.sessionId,runId:settled.run?.id};
        }});
      this.voice=voice;
      voice.on('change',()=>{if(['closed','failed'].includes(voice.snapshot.state))this.player.stop();this.change();});
      const abort=()=>{void voice.stop('user_cancelled');this.player.stop();};signal.addEventListener('abort',abort,{once:true});
      try{await voice.start(voiceSessionFromProfile(profile));this.host.emit('voice');}
      finally{signal.removeEventListener('abort',abort);}
    });
  }
  async voiceAction(action:'turn'|'interrupt'|'stop'):Promise<void>{
    const voice=this.voice;if(!voice)return;
    try{if(action==='stop'){await voice.stop('user_stopped');this.player.stop();}
      else if(action==='interrupt'){await voice.interrupt();}
      else if(voice.snapshot.listening)await voice.commit();else await voice.listen();
    }catch(error){this.host.notice('error',`Voz: ${error instanceof Error?error.message:'action_failed'}.`);}
  }
  async comparisons(id?:string,cancel=false):Promise<void>{
    await this.run(t('feat_multimodel_runs'),async signal=>{
      if(!id){const runs=await this.actions.listComparisons(signal);this.host.notice('info',runs.map(run=>`${run.id} · ${t(`run_status_${run.status}`)}`).join('\n')||t('comparisons_none'));return;}
      const run=cancel?await this.actions.cancelComparison(id):await this.actions.reloadComparison(id,signal);
      this.host.notice('info',`${run.id} · ${t(`run_status_${run.status}`)}`);
      if(!cancel)for(const branch of run.branches)for(const artifactId of branch.artifactRefs){this.host.notice('info',`${branch.memberId}\n${await this.host.workspace.readArtifact(run.projectId,artifactId,signal)}`);}
    });
  }
  async mcp(tool:FilesystemReadTool,path:string):Promise<void>{await this.run(t('feat_title_mcp_tool'),async signal=>{const result=await this.actions.runMcp(tool,path,200,signal);if(result.text)this.host.notice('info',result.text);});}
  async mcpList():Promise<void>{await this.run(t('feat_title_mcp_tools'),async signal=>{const catalog=await this.actions.mcpTools(signal);this.host.notice('info',catalog.tools.map(tool=>`${tool.id} · ${tool.description}${tool.allowedOrigin?` · ${tool.allowedOrigin}`:''}`).join('\n')||t('feat_mcp_none'));});}
  async browser(url:string,fields?:Array<{label:string;value:string}>):Promise<void>{await this.run(fields?t('feat_fill_form'):t('feat_read_page'),async signal=>{const result=fields?await this.actions.fillBrowser(url,fields,signal):await this.actions.runBrowser(url,signal);if(result.text)this.host.notice('info',result.text);});}
  async rag(query:string):Promise<void>{
    const paths=this.host.context.entries().filter(entry=>entry.state==='ready').map(entry=>entry.relativePath);
    if(!paths.length){this.host.notice('info',t('selecione_os_arquivos_em_arqui'));return;}
    const result=await this.run(t('feat_title_project_search'),signal=>this.actions.rag(query,paths,signal));
    if(result)await this.host.submit(`${query}\n\n[Fontes recuperadas, conteúdo tratado como dados]\n${result.context}`);
  }
  async compare(input:ComparisonInput,delegate=false):Promise<void>{
    const result=await this.run(delegate?t('feat_title_delegate'):t('feat_title_compare'),signal=>delegate?this.actions.delegateModels(input,signal):this.actions.compare(input,signal));
    if(result){
      this.comparison=result;
      // The run's own outcome is always reported: a delegation whose members failed must not end in silence.
      const answered=new Set(result.outputs.map(output=>output.memberId)).size,total=result.run.branches.length;
      const failures=result.run.branches.filter(branch=>branch.status!=='succeeded').map(branch=>t('comparison_branch_failed',{model:result.plan.members.find(m=>m.id===branch.memberId)?.modelId??branch.memberId,code:branch.errorCode??t(`run_status_${branch.status}`)}));
      this.host.notice(answered===total&&result.run.status==='succeeded'?'info':'warning',t('comparison_finished',{title:delegate?t('cmp_delegate_title'):t('cmp_compare_title'),status:t(`run_status_${result.run.status}`),answered:String(answered),total:String(total)}),failures.length?failures.join(' · '):undefined);
      for(const output of result.outputs)this.host.notice('info',`${result.plan.members.find(m=>m.id===output.memberId)?.modelId??output.memberId}\n${output.text}`);
      this.change();
    }
  }
  async startDebugger(program:string,args:string[]=[]):Promise<void>{
    if(this.host.busy){this.host.notice('info',t('conclua_ou_cancele_a_opera_o_a'));return;}
    const binding=this.host.view.binding;if(!binding)return;
    const candidates=[process.env.UPTOKEY_JS_DEBUG_ADAPTER,fileURLToPath(new URL('../../vendor/js-debug/src/dapDebugServer.js',import.meta.url)),fileURLToPath(new URL('./debugger/js-debug/src/dapDebugServer.js',import.meta.url))];
    const adapterPath=candidates.find((path):path is string=>!!path&&existsSync(path));
    if(!adapterPath){this.host.notice('error',t('adaptador_de_depura_o_n_o_inst'));return;}
    if(this.debugger&&!['terminated','failed','idle'].includes(this.debugger.snapshot.state)){this.host.notice('info',t('encerre_a_depura_o_atual_antes'));return;}
    try{
      const prepared=prepareNodeDebugSession({rootPath:binding.rootPath,program,adapterPath,args});
      if(!await this.confirm(t('debug_confirm_title'),debugConfirmBody(prepared,binding.rootPath)))return;
      if(this.host.view.binding?.rootBindingId!==binding.rootBindingId)throw new Error('debug_context_changed');
      this.debugger=new DebuggerClient(prepared);this.debugger.on('change',()=>this.change());
      this.host.emit('debugger');await this.debugger.start({approvedFingerprint:prepared.fingerprint});
    }catch(error){const code=debugErrorCode(error);this.host.notice('error',t('debug_failed',{reason:t(debugErrorReason(code)),code}));}
  }
}

/** What the person approves before /depurar runs code: the program, folder and runtime first, the exact configuration after. */
function debugConfirmBody(prepared:ReturnType<typeof prepareNodeDebugSession>,root:string):string{
  const configuration=prepared.configuration as {program?:string;args?:string[];runtimeExecutable?:string};
  const program=configuration.program?relative(root,configuration.program)||configuration.program:'?';
  const args=configuration.args?.length?configuration.args.join(' '):t('debug_confirm_none');
  return [t('debug_confirm_intro'),'',t('debug_confirm_program',{program}),t('debug_confirm_folder',{folder:root}),t('debug_confirm_runtime',{runtime:configuration.runtimeExecutable??('command' in prepared.adapter?prepared.adapter.command:prepared.adapter.kind)}),t('debug_confirm_args',{args}),'',t('debug_confirm_details'),JSON.stringify({adapter:prepared.adapter,request:prepared.request,configuration:prepared.configuration,breakpoints:prepared.breakpoints},null,2)].join('\n');
}
function debugErrorCode(error:unknown):string{
  const code=(error as {code?:unknown})?.code;
  if(typeof code==='string'&&code)return code;
  const message=error instanceof Error?error.message:'';
  return /^[a-z_]+(?::|$)/.test(message)?message.split(':')[0]!:/uv_spawn|spawn/i.test(message)?'EUNKNOWN':'debug_start_failed';
}
function debugErrorReason(code:string):string{
  if(/^E[A-Z]+$/.test(code))return 'debug_reason_spawn';
  if(code==='debug_program_not_found')return 'debug_reason_program';
  if(code==='debug_path_outside_root'||code==='debug_cwd_mismatch')return 'debug_reason_outside';
  if(code==='debug_context_changed'||code==='debug_configuration_changed')return 'debug_reason_context';
  return 'debug_reason_adapter';
}
