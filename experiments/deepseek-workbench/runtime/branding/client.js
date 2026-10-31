// Uptokey brand occupants for the original Harness slot contracts.
window.__ModuleLoader__.load({
 id:'@deepseek-ai/dsh-client-ui-brand-official',
 factory:require=>{
  const {jsx}=require('react/jsx-runtime');
  const image='url("__UPTOKEY_MARK__")';
  function Mark({size=24,className}){
   return jsx('span',{className,role:'img','aria-label':'Uptokey','data-uptokey-mark':true,
    style:{display:'inline-block',width:size,height:size,flexShrink:0,backgroundColor:'currentColor',
     maskImage:image,maskRepeat:'no-repeat',maskPosition:'center',maskSize:'contain',
     WebkitMaskImage:image,WebkitMaskRepeat:'no-repeat',WebkitMaskPosition:'center',WebkitMaskSize:'contain'}});
  }
  function Name(){return jsx('span',{style:{fontWeight:500},children:'Uptokey'});}
  return {inject:['slots','uiSession','remote'],apply(ctx){
   window.UptokeyHarnessThemeUI?.apply(ctx);
   window.UptokeyHarnessWorkspaceUI?.apply(ctx);
   window.UptokeyHarnessWorkspaceFeedback?.apply(ctx,require);
   window.UptokeyHarnessAccountUI?.apply(ctx,require);
   window.UptokeyHarnessModelCatalog?.apply(ctx);
   window.UptokeyHarnessModelPages?.apply(ctx,require);
   window.UptokeyHarnessPublicApiUI?.apply(ctx,require);
   window.UptokeyHarnessLifecycleNotifications?.apply(ctx);
   ctx.slots.inject('sidebar.brand.mark',()=>ctx.slots.inject('sidebar.brand.name',function*(){
    yield ctx.slots.register({name:'sidebar.brand.mark'},Mark);
    yield ctx.slots.register({name:'sidebar.brand.name'},Name);
   }));
   ctx.slots.inject('conversation.hero.brand.mark',()=>ctx.slots.register({name:'conversation.hero.brand.mark'},Mark));
  }};
 }
});
