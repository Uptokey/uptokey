import { createLinearInput } from './linear-input.ts'
import { writeSync } from 'node:fs'
import { COMMANDS, resolveSlash, runCommand, type PanelName, type UiActions } from '../../commands.ts'
import { ui } from './i18n.ts'
import { terminalText } from './integration-terminal.ts'
import { prepareConnection, connectionText } from './integration-connections.ts'
import { setupErrorText } from './integration-connections.ts'
import { SettledTranscriptProjection } from './linear-projection.ts'
import type { UptokeyBackend } from './backend/index.ts'
import { write as copy, clipboardErrorMessage } from '../vendor/opencode-tui/clipboard.ts'
import { assertFrontendExportAllowed } from './export-policy.ts'
import { transcriptCodeBlockText } from '../../clipboard.ts'
import { localizedDiagnostic } from '../../operation-ui.ts'
import { readUsageRows } from './integration-connections.ts'
import { runLinearAccount, accountSummary } from './linear-account.ts'

/** Accessible presentation of the same controller, commands, vault, approvals and receipts. No alternate renderer. */
export async function runLinearFrontend(backend:UptokeyBackend, connect?:string) {
  const {input,output,ask}=createLinearInput()
  const controller=backend.controller
  let closed=false
  let draft=''
  let accountObserved=false
  let lastAccountSummary=''
  const say=(text:string)=>process.stdout.write(`\n${text}\n`)
  const failure=(error:unknown)=>say(localizedDiagnostic(error && typeof error==='object' && 'code' in error ? error.code : undefined))
  const choose=async<T>(rows:readonly T[],label:(value:T)=>string):Promise<T|undefined>=>{
    if(!rows.length){say(terminalText('no_items'));return}
    rows.forEach((value,index)=>say(`${index+1}. ${label(value)}`))
    for(;;){const answer=(await ask(terminalText('choose'))).trim();if(!answer)return;const value=rows[Number(answer)-1];if(value)return value}
  }
  const leave=()=>{closed=true;input.close()}
  const fullInterface=()=>{
    const fd=Number(process.env.UPTOKEY_TUI_HANDOFF_FD)
    if(Number.isInteger(fd)&&fd>=3){writeSync(fd,JSON.stringify({screenReader:false,conversationId:controller.state.activeConversation?.id??null}));input.close();process.exitCode=75;closed=true}
    else say(terminalText('linear_hint'))
  }
  const setup=async(id?:string)=>{
    const service=backend.providerSetup
    if(!service){say(ui('connect_unavailable'));return}
    const choices=backend.providerChoices().filter(item=>item.executable)
    const choice=id?choices.find(item=>item.id===id):await choose(choices,item=>item.label)
    if(!choice)return
    const prepared=await prepareConnection({service,choice,
      requestKey:async(error)=>{if(error)say(setupErrorText(error));const key=await ask(`${ui('secret_placeholder')}: `,true);return key||null},
      requestModel:async(error)=>{if(error)say(setupErrorText(error));say(connectionText('manual_hint'));return (await ask(`${connectionText('manual_model')}: `))||null},
      requestEndpoint:async()=> (await ask(`${ui('connect_endpoint')}: `))||null,
      busy:()=>say(ui('connect_loading'))})
    if(!prepared)return
    try {
      if(prepared.notice)say(prepared.notice)
      const model=await choose(prepared.models,value=>value.name?`${value.name} · ${value.id}`:value.id)
      if(!model)return
      const result=await prepared.commit(model.id,{acceptNotice:true})
      await backend.finishProviderSetup(result.providerId,result.modelId,result.routingComboId)
      say(ui('connect_done',{provider:prepared.label,model:model.id}))
    }finally{prepared.dispose()}
  }
  const panel=async(name:PanelName,arg?:string)=>{
    if(name==='account'){accountObserved=true;return runLinearAccount(controller.account,{say,choose})}
    if(name==='connections')return setup(arg)
    if(name==='models'){
      await controller.refreshConnections()
      const rows=controller.view.connections?.providers.filter(p=>p.eligible).flatMap(p=>p.models.map(id=>({provider:p.id,id,label:p.displayName})))??[]
      const item=await choose(rows,value=>`${value.label} · ${value.id}`)
      if(item)await controller.selectProviderModel(item.id,item.provider)
      return
    }
    if(name==='projects'){
      const path=arg||(await ask(`${ui('project_path_prompt')}: `))
      if(path)await controller.rebindProject(path)
      const candidate=await choose(controller.view.bindingCandidates??[],value=>`${value.projectName} · ${value.rootBindingId.slice(-8)}`)
      if(candidate)await controller.chooseBinding(candidate)
      return
    }
    if(name==='sessions'){
      await controller.refreshConversationList()
      const item=await choose(controller.state.conversations,value=>value.title||value.id)
      if(item)await controller.openConversation(item.id)
      return
    }
    if(name==='files'){
      const item=await choose(await backend.searchPaths(arg??'',60),value=>value.path)
      if(item?.type==='file')await controller.addContext(item.path)
      return
    }
    if(name==='context'){say(controller.context.entries().map(value=>value.relativePath).join('\n')||ui('p_ctx_empty'));return}
    if(name==='review'){if(controller.view.proposal)say(controller.view.proposal.files.map(value=>value.path).join('\n'));say(terminalText('decision'));return}
    if(name==='help'){say(COMMANDS.map(value=>`/${value.slash[0]} · ${value.title}`).join('\n'));return}
    if(name==='usage'){
      say(ui('p_usage_tokens',{tokens:String(controller.state.estimatedTokens)}))
      say(ui('p_usage_cost',{cost:controller.state.sessionCost.toFixed(4)}))
      const rows=readUsageRows(await controller.client.getUsage())
      say(rows?connectionText('usage_total',{tokens:rows.reduce((sum,row)=>sum+row.totalTokens,0)}):connectionText('unavailable'))
      for(const row of rows??[])say(`${row.provider}\n${connectionText('usage_provider',{input:row.inputTokens,output:row.outputTokens,reported:row.responsesWithUsage,unreported:row.responsesWithoutUsage,interrupted:row.interruptedResponses,active:row.responsesInFlight})}`)
      return
    }
    if(name==='doctor'){
      const health=await controller.client.health()
      say(connectionText(health.status==='ok'&&controller.state.connection==='authenticated'?'ready':'attention'))
      say(connectionText('core',{version:health.version||controller.state.coreVersion||'—',url:controller.client.url}))
      say(ui('p_doctor_destination',{destination:`${controller.client.getSelectedDestination().providerId??ui('p_none')} · ${controller.state.selectedModel||ui('p_none')}`}))
      say(ui('p_doctor_project',{project:controller.view.binding?.rootPath??ui('p_none')}))
      return
    }
    // Full-feature panels are available without losing the current conversation or draft.
    say(terminalText('linear_hint'))
  }
  const actions:UiActions={
    openPanel:(name,arg)=>{void panel(name,arg).catch(failure)},
    closePanel:()=>{},setDraft:text=>{draft=text},exit:leave,startService:()=>controller.start(),
    toggleExpanded:()=>say(terminalText('linear_hint')),setLinear:on=>{if(!on)fullInterface()},setTheme:()=>say(terminalText('linear_hint')),
    beginTranscriptSelection:()=>say(terminalText('linear_hint')),showChatFiles:()=>say(terminalText('linear_hint')),
    copyTranscript:async(scope)=>{assertFrontendExportAllowed(controller.state.storagePolicy==='temporary');const items=controller.state.messages.filter(m=>!m.streaming);const text=scope==='response'?[...items].reverse().find(m=>m.role==='assistant')?.content:items.filter(m=>m.role==='assistant'||m.role==='user').map(m=>`## ${m.role==='user'?ui('copy_label_user'):ui('copy_label_assistant')}\n\n${m.content}`).join('\n\n');if(text)await copy(text)},
    copyCodeBlock:async()=>{assertFrontendExportAllowed(controller.state.storagePolicy==='temporary');const text=transcriptCodeBlockText(controller.items());if(text)await copy(text)},
  }
  const projection=new SettledTranscriptProjection()
  let lastDecision=''
  const render=()=>{
    if(accountObserved){const summary=accountSummary(controller.account);if(summary!==lastAccountSummary){say(summary);lastAccountSummary=summary}}
    for(const text of projection.take(controller.state.activeConversation?.id??'',controller.items(),process.stdout.columns||100))say(text)
    const decision=controller.features.review?.id??controller.view.proposal?.id??controller.view.approvals[0]?.id??(controller.view.lspConsentRequest?`lsp-consent-${controller.view.lspConsentRequest.spec.id}`:'')
    if(decision&&decision!==lastDecision)say(terminalText('decision'))
    lastDecision=decision
  }
  controller.on('change',render)
  input.on('SIGINT',()=>{if(controller.busy)controller.cancel();else leave()})
  try{
    await backend.whenReady()
    say(`Uptokey\n${terminalText('linear_hint')}`);render()
    if(connect)await setup(connect)
    while(!closed){
      let line:string
      try{line=await ask(draft?`${draft}\n> `:'> ');if(draft){line=line||draft;draft=''}}catch{break}
      if(!line.trim())continue
      if(['/approve','/reject'].includes(line.trim())){if(lastDecision)void backend.permissionReply(lastDecision,line.trim()==='/approve'?'once':'reject').catch(failure);continue}
      const command=resolveSlash(line)
      if(command){
        // Await interactive panels here: another prompt cannot consume their answer.
        let requested:{name:PanelName,arg?:string}|undefined
        try {
          await runCommand(command.command,{controller,ui:{...actions,openPanel:(name,arg)=>{requested={name,arg}}}},command.arg)
          if(requested)await panel(requested.name,requested.arg)
        } catch(error) { command.command.id==='chat.copy'?say(clipboardErrorMessage(error)):failure(error) }
        continue
      }
      if(line.startsWith('/')){say(terminalText('linear_hint'));continue}
      void controller.submit(line).catch(error=>{draft=line;failure(error)})
    }
  }finally{controller.off('change',render);input.close();output.end()}
}
