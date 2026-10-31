// Container policy only. Attachment providers and durable objects stay original.
export const CACHE_PATH='/home/node/.dsh/cache/attachments';
export const CACHE_LABEL='io.uptokey.attachment-cache';
export const CACHE_POLICY='tmpfs-noswap-v1';
export const CONTROLLER_MEMORY=1536*1024*1024;
export function attachmentCacheArguments(){return[
 '--label',`${CACHE_LABEL}=${CACHE_POLICY}`,
 '--memory-swap','1536m',
 '--mount',`type=tmpfs,target=${CACHE_PATH},tmpfs-size=268435456,tmpfs-mode=0700,notmpcopyup,nosuid,nodev,noexec,noswap,U=true`,
];}
export function assertAttachmentCachePolicy(item){
 const options=new Set(String(item?.HostConfig?.Tmpfs?.[CACHE_PATH]??'').split(','));
 // Podman inspect omits the default rw and represents notmpcopyup by absence.
 const required=['nosuid','nodev','noexec','noswap'];
 const owner=(options.has('uid=1000')&&options.has('gid=1000'))||options.has('U=true')||options.has('U');
 const mode=options.has('mode=0700')||options.has('mode=700');
 const size=options.has('size=256m')||options.has('size=262144k')||options.has('size=268435456');
 if(item?.Config?.Labels?.[CACHE_LABEL]!==CACHE_POLICY||required.some(option=>!options.has(option))||options.has('ro')||options.has('tmpcopyup')||!owner||!mode||!size
  ||item?.HostConfig?.Memory!==CONTROLLER_MEMORY||item?.HostConfig?.MemorySwap!==CONTROLLER_MEMORY)throw Error('Laboratory cache policy changed; use refresh to apply it.');
}
