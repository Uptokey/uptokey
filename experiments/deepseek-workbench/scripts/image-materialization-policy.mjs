export const IMAGE_VOLUME='uptokey-workbench-image-materialization-v1';
export const IMAGE_PATH='/home/node/.dsh/uptokey-image-materialization';
export const IMAGE_POLICY='shared-tmpfs-noswap-v1';
const LABEL='io.uptokey.image-materialization';
const OWNER='io.uptokey.experiment';
const options='noswap,nodev,noexec,nosuid,size=256m,uid=1000,gid=1000,mode=0700';
export function imageVolumeArguments({explicitOwnership=true}={}){return['volume','create','--label',`${OWNER}=deepseek-workbench`,'--label',`${LABEL}=${IMAGE_POLICY}`,...(explicitOwnership?['--uid','1000','--gid','1000']:[]),'--driver','local','--opt','type=tmpfs','--opt','device=tmpfs','--opt',`o=${options}`,IMAGE_VOLUME];}
export function supportsExplicitVolumeOwnership(help){
 if(typeof help!=='string'||!/\bUsage\s*:/i.test(help)||!/^[ \t]*(?:-\w,[ \t]*)?--opt(?:[=\s,]|$)/m.test(help))throw Error('image_volume_capabilities_unavailable');
 const uid=/^[ \t]*--uid(?:[=\s,]|$)/m.test(help),gid=/^[ \t]*--gid(?:[=\s,]|$)/m.test(help);
 if(uid!==gid)throw Error('image_volume_capabilities_incomplete');
 return uid;
}
export function assertImageVolume(volume){
 const opts=new Set(String(volume?.Options?.o??'').split(','));
 const required=['noswap','nodev','noexec','nosuid','size=256m','uid=1000','gid=1000','mode=0700'];
 if(volume?.Name!==IMAGE_VOLUME||volume?.Driver!=='local'||volume?.Labels?.[OWNER]!=='deepseek-workbench'||volume?.Labels?.[LABEL]!==IMAGE_POLICY||volume?.Options?.type!=='tmpfs'||volume?.Options?.device!=='tmpfs'
  ||required.some(x=>!opts.has(x))||opts.size!==required.length||String(volume?.Options?.UID)!=='1000'||String(volume?.Options?.GID)!=='1000')throw Error('image_materialization_volume_policy_invalid');
}
export function imageMountArguments(readonly=false){return['--label',`${LABEL}=${IMAGE_POLICY}`,'-v',`${IMAGE_VOLUME}:${IMAGE_PATH}:${readonly?'ro':'rw'},nocopy,nosuid,nodev,noexec`];}
export function assertImageMount(item,readonly=false){
 const mounts=item?.Mounts?.filter(m=>m.Destination===IMAGE_PATH);
 const prefix=IMAGE_VOLUME+':'+IMAGE_PATH+':',binds=item?.HostConfig?.Binds?.filter(x=>x.startsWith(prefix))??[];
 const options=new Set((binds[0]?.slice(prefix.length)??'').split(','));
 if(item?.Config?.Labels?.[LABEL]!==IMAGE_POLICY||mounts?.length!==1||mounts[0].Type!=='volume'||mounts[0].Name!==IMAGE_VOLUME||mounts[0].RW!==!readonly
  ||binds.length!==1||['nocopy','nosuid','nodev','noexec'].some(x=>!options.has(x))||['copy','suid','dev','exec'].some(x=>options.has(x))||!options.has(readonly?'ro':'rw')||options.has(readonly?'rw':'ro'))throw Error('image_materialization_mount_policy_invalid');
}
export function ensureImageVolume({exists,run,supportsExplicitOwnership=()=>true}){
 if(!exists())run(imageVolumeArguments({explicitOwnership:supportsExplicitOwnership()}));
 const volume=JSON.parse(run(['volume','inspect',IMAGE_VOLUME]))[0];assertImageVolume(volume);
}
