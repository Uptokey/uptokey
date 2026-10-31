// Native-attention projection from the Harness's authoritative UI Session store.
(function(){
 const pendingKind=kind=>kind==='approval'?'permission':kind==='question'||kind==='plan-review'?'question':undefined;
 function transitions(previous,current){
  const kinds=[];
  for(const [sessionId,status] of current??[]){
   const before=previous?.get?.(sessionId);
   const pending=status?.pendingInteraction;
   const kind=pendingKind(pending?.kind);
   if(kind!==undefined&&(before?.pendingInteraction?.key!==pending.key||before?.pendingInteraction?.kind!==pending.kind))kinds.push(kind);
   if(before?.running===true&&status?.running===false&&status?.completionUnread===true)kinds.push('session-done');
  }
  return kinds;
 }
 window.UptokeyHarnessLifecycleNotifications=Object.freeze({transitions,apply(ctx){
  const store=ctx?.uiSession?.sessionStatus;
  const hasStatus=typeof store?.getSnapshot==='function'&&typeof store?.subscribe==='function';
  const hasError=typeof ctx?.remote?.$on==='function';
  if(!hasStatus&&!hasError)return;
  let disposeError;
  if(hasError){
   try{
    disposeError=ctx.remote.$on('api-session/error',()=>{
     window.dispatchEvent(new CustomEvent('uptokey:native-attention',{detail:{kind:'error'}}));
    });
   }catch{}
  }
  if(!hasStatus&&disposeError===undefined)return;
  ctx.effect(()=>{
   let previous=hasStatus?store.getSnapshot():undefined;
   const changed=()=>{
    const current=store.getSnapshot();
    for(const kind of transitions(previous,current))window.dispatchEvent(new CustomEvent('uptokey:native-attention',{detail:{kind}}));
    previous=current;
   };
   const disposeStatus=hasStatus?store.subscribe(changed):undefined;
   return()=>{disposeStatus?.();disposeError?.();};
  },'uptokey: authoritative native attention');
 }});
})();
