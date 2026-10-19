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
import { HOSTED_PROVIDER, type TuiHostedModel } from '../../hosted.ts'
import type { ConnectionsSnapshot } from '../../connections.ts'
import type { AccountView } from '../../account.ts'
import { runLinearProviderDisconnect } from './provider-actions.ts'
import { accountText } from '../../account-ui.ts'

type LinearModelInventory = {
  view: { connections: ConnectionsSnapshot | null }
  account: { view: Pick<AccountView, 'session' | 'available'> }
  hostedModels: readonly TuiHostedModel[]
}

/** The same real destinations as the fullscreen picker; account navigation is never represented as a model. */
export function linearModelChoices(controller: LinearModelInventory, query = '') {
  const own = controller.view.connections?.providers.filter(provider => provider.eligible)
    .flatMap(provider => provider.models.map(id => ({ provider: provider.id, id, label: provider.displayName, name: id, hosted: false }))) ?? []
  const account = controller.account.view
  const hosted = account.session?.authenticated && account.available?.currentAccountRef
    ? controller.hostedModels.filter(model => model.accountRef === account.available!.currentAccountRef && model.revision === account.available!.revision)
      .map(model => ({ provider: HOSTED_PROVIDER, id: model.modelId, label: 'Uptokey', name: model.label, hosted: true }))
    : []
  const needle = query.trim().toLowerCase()
  return [...own, ...hosted].filter(model => !needle || `${model.label} ${model.name} ${model.id} ${model.hosted ? 'Uptokey Free Plus' : ''}`.toLowerCase().includes(needle))
}

/** Opening the menu does not invalidate a usable catalog or wait for hosted networking. */
export async function loadLinearModelChoices(controller: LinearModelInventory & { refreshConnections(): Promise<void> }, query = '') {
  if (!controller.view.connections) await controller.refreshConnections()
  return linearModelChoices(controller, query)
}

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
    const choices=backend.providerChoices().filter(item=>item.executable)
    const rows = choices.map(value => ({ kind: 'provider' as const, label: value.label, value }))
    const uptokey = { kind: 'account' as const, label: 'Uptokey', value: undefined }
    const configured=(row:typeof rows[number])=>row.value.configured||controller.view.connections?.connections?.some(item=>item.providerId===row.value.id&&/^[0-9a-f-]{36}$/i.test(item.id))===true
    const own = rows.filter(configured).flatMap(row => [row, ...(!row.value.local ? [{ kind: 'disconnect' as const, label: ui('provider_disconnect', { name: row.label }), value: row.value }] : [])])
    const options = [...own, uptokey, ...rows.filter(row => !configured(row))]
    const selected=id?(id.toLowerCase()==='uptokey'||id===HOSTED_PROVIDER?uptokey:rows.find(row=>row.value.id===id)):await choose(options,item=>item.label)
    if(selected?.kind==='disconnect')return runLinearProviderDisconnect(backend,selected.value.id,selected.value.label,{say,choose})
    if(selected?.kind==='account'){
      const models=linearModelChoices(controller).filter(model=>model.hosted)
      if(!models.length){accountObserved=true;return runLinearAccount(controller.account,{say,choose})}
      const actions = [...models.map(model => ({ kind: 'model' as const, label: `${model.label} · ${model.name}`, model })),
        ...(controller.account.view.connectionNeeded ? [{ kind: 'connect' as const, label: accountText('connect_terminal'), model: undefined }] : []),
        { kind: 'disconnect' as const, label: ui('provider_disconnect',{name:'Uptokey'}), model: undefined }]
      const action=await choose(actions,value=>value.label)
      if(action?.kind==='model')await controller.selectProviderModel(action.model.id,action.model.provider)
      if(action?.kind==='connect'){await controller.account.connectHosted();accountObserved=true;return runLinearAccount(controller.account,{say,choose})}
      if(action?.kind==='disconnect')await runLinearProviderDisconnect(backend,HOSTED_PROVIDER,'Uptokey',{say,choose})
      return
    }
    const choice=selected?.value
    if(!choice)return
    const service=backend.providerSetup
    if(!service){say(ui('connect_unavailable'));return}
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
      const rows=await loadLinearModelChoices(controller,arg)
      if(!rows.length&&['uptokey','free','plus'].includes(arg?.trim().toLowerCase()??'')){accountObserved=true;return runLinearAccount(controller.account,{say,choose})}
      const item=await choose(rows,value=>`${value.label} · ${value.name}`)
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
