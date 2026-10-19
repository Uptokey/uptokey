import { test, expect } from "bun:test"
import { disconnectProvider, disconnectTargets, runLinearProviderDisconnect } from "./provider-actions.ts"
const ref="acc_"+"a".repeat(64), named="11111111-1111-4111-8111-111111111111", other="22222222-2222-4222-8222-222222222222"
function fixture() {
  let destination:any={providerId:"groq",connectionId:named}, revision=1
  const calls:string[]=[], account={view:{session:{authenticated:true},available:{currentAccountRef:ref,revision:3,currentOwned:true},error:null},async logout(){calls.push("logout");this.view.session.authenticated=false},async disconnect(){calls.push("unlink");this.view.session.authenticated=false}}
  const controller:any={account,view:{connections:{providers:[{id:"groq",configured:true}],connections:[{id:named,providerId:"groq",enabled:true,label:"Work"},{id:other,providerId:"groq",enabled:true,label:"Personal"}]}},client:{getSelectedDestination:()=>destination},get modelSelectionRevision(){return revision},cancel(){calls.push("cancel")},setModel(value:string){calls.push("model:"+value);destination={};revision++},async refreshConnections(){calls.push("refresh")},async refreshHostedModels(){calls.push("hosted-refresh")}}
  const backend:any={controller,providerSetup:{async disconnect(provider:string,id:string){calls.push(`${provider}:${id}`)}},refreshAll(){calls.push("frontend-refresh")}}
  return {backend,controller,calls,account,setDestination(value:unknown){destination=value;revision++}}
}
test("disconnect targets keep separate provider credentials instead of broadening to the provider",()=>{const f=fixture();expect(disconnectTargets(f.backend,"groq","Groq").map(row=>row.connectionId)).toEqual([named,other])})
test("an observed default remains alongside named and disabled saved credentials",()=>{const f=fixture();f.controller.view.connections.connections.push({id:"groq",providerId:"groq",enabled:false,label:"Groq default"});expect(disconnectTargets(f.backend,"groq","Groq").map(row=>row.connectionId)).toEqual([named,other,"groq"])})
test("revoking one named connection clears only its current selection after actual success",async()=>{const f=fixture();await disconnectProvider(f.backend,{providerId:"groq",connectionId:named,label:"Work"});expect(f.calls).toEqual([`groq:${named}`,"cancel","model:","refresh","frontend-refresh"]);expect(f.account.view.session.authenticated).toBe(true)})
test("another connection or a newer user selection survives revocation",async()=>{
  const f=fixture();await disconnectProvider(f.backend,{providerId:"groq",connectionId:other,label:"Personal"});expect(f.calls).not.toContain("model:")
  const g=fixture();g.backend.providerSetup.disconnect=async()=>{g.setDestination({providerId:"ollama",connectionId:"ollama"})};await disconnectProvider(g.backend,{providerId:"groq",connectionId:named,label:"Work"});expect(g.calls).not.toContain("model:")
})

test("revoking a profile clears only a same-provider legacy alias instead of silently switching its account",async()=>{
  for(const destination of [{providerId:"groq",connectionId:"groq"},{providerId:"groq"}]){
    const f=fixture();f.setDestination(destination);await disconnectProvider(f.backend,{providerId:"groq",connectionId:named,label:"Work"});expect(f.calls).toEqual([`groq:${named}`,"cancel","model:","refresh","frontend-refresh"])
  }
  const changed=fixture();changed.setDestination({providerId:"groq",connectionId:"groq"});changed.backend.providerSetup.disconnect=async()=>changed.setDestination({providerId:"groq",connectionId:other});await disconnectProvider(changed.backend,{providerId:"groq",connectionId:named,label:"Work"});expect(changed.calls).not.toContain("model:");expect(changed.controller.client.getSelectedDestination().connectionId).toBe(other)
})
test("a refused revocation leaves selection and other account untouched",async()=>{const f=fixture();f.backend.providerSetup.disconnect=async()=>{throw Error("revision_conflict")};await expect(disconnectProvider(f.backend,{providerId:"groq",connectionId:named,label:"Work"})).rejects.toThrow();expect(f.calls).toEqual([]);expect(f.controller.client.getSelectedDestination().connectionId).toBe(named);expect(f.account.view.session.authenticated).toBe(true)})
test("Uptokey disconnect follows ownership, invalidates hosted choices and refuses a changed account",async()=>{
  const f=fixture(),target=disconnectTargets(f.backend,"uptokey-hosted","Uptokey")[0]!;await disconnectProvider(f.backend,target);expect(f.calls).toEqual(["logout","hosted-refresh","frontend-refresh"])
  const g=fixture();g.account.view.available.currentOwned=false;await disconnectProvider(g.backend,disconnectTargets(g.backend,"uptokey-hosted","Uptokey")[0]!);expect(g.calls[0]).toBe("unlink")
  const h=fixture(),old=disconnectTargets(h.backend,"uptokey-hosted","Uptokey")[0]!;h.account.view.available.revision++;await expect(disconnectProvider(h.backend,old)).rejects.toThrow("account_share_conflict");expect(h.calls).toEqual([])
})
test("linear confirmation starts with Cancel and does not disconnect on cancellation",async()=>{const f=fixture();let first='';await runLinearProviderDisconnect(f.backend,"uptokey-hosted","Uptokey",{say(){},async choose(rows,label){first=label(rows[0]!);return rows[0]}});expect(first).toBeTruthy();expect(f.calls).toEqual([])})
