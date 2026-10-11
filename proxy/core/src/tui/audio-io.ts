/** Native, bounded PCM capture. Microphone access only follows an explicit command.
 * No recording file, shell, provider credential or transcript cache is created.
 * FFmpeg is an optional platform dependency; playback accepts PCM/WAV only.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { resolveProgram } from './lsp.ts';

export const AUDIO_RATE = 24000;
export const AUDIO_MAX_MS = 120000;
export function ffmpegPath(): string | null {
  const configured = process.env.UPTOKEY_FFMPEG_PATH;
  if (configured) return existsSync(configured) ? configured : null;
  const system = resolveProgram('ffmpeg');
  if (system) return system;
  const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return [new URL(`../../vendor/native-audio/bin/${binary}`,import.meta.url),new URL(`../vendor/native-audio/bin/${binary}`,import.meta.url)].map(url => fileURLToPath(url)).find(existsSync) ?? null;
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','HOME','USERPROFILE','XDG_RUNTIME_DIR','PULSE_SERVER','LANG','LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function captureArguments(platform: NodeJS.Platform, device?: string): string[] {
  const prefix = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (device?.includes('\0')) throw new Error('audio_device_invalid');
  const input = platform === 'win32' ? ['-f','dshow','-i',`audio=${device || 'default'}`]
    : platform === 'darwin' ? ['-f','avfoundation','-i',`:${device || '0'}`]
    : ['-f','pulse','-i',device || 'default'];
  return [...prefix,...input,'-vn','-ac','1','-ar',String(AUDIO_RATE),'-f','s16le','pipe:1'];
}

/** A Windows device is selected by its real enumerated name, never a guessed ID. */
export async function audioDevices(signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  const command = ffmpegPath();
  if (!command) throw new Error('audio_capture_unavailable');
  if (process.platform !== 'win32') return ['default'];
  return new Promise((resolve, reject) => {
    const child = spawn(command,['-hide_banner','-list_devices','true','-f','dshow','-i','dummy'],{windowsHide:true,env:environment(),stdio:['ignore','ignore','pipe']});
    const cancel=()=>{child.kill();reject(new Error('audio_capture_cancelled'));};
    signal?.addEventListener('abort',cancel,{once:true});
    let output = ''; const timer = setTimeout(() => {child.kill(); reject(new Error('audio_device_timeout'));},5000);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
    child.stderr.on('data',(chunk:Buffer)=> { if (output.length < 65536) output += chunk.toString(); });
    child.once('error',error=>{cleanup();reject(error);});
    child.once('close',()=>{cleanup();if(signal?.aborted)reject(new Error('audio_capture_cancelled'));else resolve([...output.matchAll(/"([^"\r\n]+)"\s+\(audio\)/g)].map(match=>match[1]!));});
  });
}

export function pcmWav(pcm: Uint8Array, rate = AUDIO_RATE): Buffer {
  if (pcm.byteLength % 2 || !Number.isSafeInteger(rate) || rate < 8000 || rate > 96000) throw new Error('audio_pcm_invalid');
  const header = Buffer.alloc(44);
  header.write('RIFF',0); header.writeUInt32LE(36+pcm.byteLength,4); header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(rate,24); header.writeUInt32LE(rate*2,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34);
  header.write('data',36); header.writeUInt32LE(pcm.byteLength,40);
  return Buffer.concat([header,pcm]);
}

export interface AudioCaptureOptions {
  /** Injectable process/device boundary; production defaults always use FFmpeg. */
  resolveCommand?:()=>string|null;
  discoverDevices?:(signal:AbortSignal)=>Promise<string[]>;
  spawnCapture?:(command:string,args:string[])=>ChildProcessWithoutNullStreams;
  maxDurationMs?:number;
}
export class AudioCapture extends EventEmitter {
  private readonly options:AudioCaptureOptions;
  private readonly maxDurationMs:number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private stopRequested = false;
  private stopReason:'limit'|'requested'|'ended'='ended';
  private starting=false;
  private discovery:AbortController|null=null;
  private epoch=0;
  private discard=false;
  private completed:Buffer|null=null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private completion: Promise<Buffer> | null = null;
  constructor(options:AudioCaptureOptions={}) {super();this.options=options;this.maxDurationMs=options.maxDurationMs??AUDIO_MAX_MS;if(!Number.isSafeInteger(this.maxDurationMs)||this.maxDurationMs<1||this.maxDurationMs>AUDIO_MAX_MS)throw new Error('audio_duration_invalid');}
  get active(): boolean { return this.child !== null || this.starting; }
  get hasRecording():boolean{return this.completion!==null;}
  get durationMs(): number { return Math.floor(this.bytes / (AUDIO_RATE*2) * 1000); }
  async start(device?: string): Promise<void> {
    if (this.active || this.hasRecording) throw new Error('audio_capture_active');
    this.starting=true;const epoch=++this.epoch;const discovery=new AbortController();this.discovery=discovery;
    try {
    const command = (this.options.resolveCommand??ffmpegPath)(); if (!command) throw new Error('audio_capture_unavailable');
    const devices = this.options.discoverDevices ? await this.options.discoverDevices(discovery.signal) : process.platform === 'win32' ? await audioDevices(discovery.signal) : [];
    if(epoch!==this.epoch||discovery.signal.aborted)throw new Error('audio_capture_cancelled');
    if (process.platform === 'win32' && !device && !devices.length) throw new Error('audio_input_missing');
    if (device && devices.length && !devices.includes(device)) throw new Error('audio_device_missing');
    this.chunks=[];this.bytes=0;this.stopRequested=false;this.discard=false;this.stopReason='ended';this.completed=null;
    const child=this.options.spawnCapture?.(command,captureArguments(process.platform,device ?? devices[0]))??spawn(command,captureArguments(process.platform,device ?? devices[0]),{windowsHide:true,env:environment(),stdio:'pipe'});
    this.child=child;
    this.completion=new Promise<Buffer>((resolve,reject)=>{
      child.stdout.on('data',(chunk:Buffer)=>{
        if(this.discard||this.child!==child)return;
        const remaining=AUDIO_RATE*2*this.maxDurationMs/1000-this.bytes;
        if(remaining<=0)return;
        const bounded=Buffer.from(chunk.subarray(0,remaining)); this.chunks.push(bounded);this.bytes+=bounded.length;
        let power=0;for(let i=0;i+1<bounded.length;i+=2){const sample=bounded.readInt16LE(i)/32768;power+=sample*sample;}
        this.emit('level',{rms:Math.sqrt(power/Math.max(1,Math.floor(bounded.length/2))),durationMs:this.durationMs});
        this.emit('pcm',bounded);
        if(this.durationMs>=this.maxDurationMs)this.requestStop('limit');
      });
      child.stderr.on('data',()=>undefined);
      const finish=()=>{if(this.child===child){if(this.timer)clearTimeout(this.timer);this.timer=null;this.child=null;}};
      let settled=false;
      child.once('error',()=>{if(settled)return;settled=true;finish();this.clear();reject(new Error('audio_capture_failed'));});
      child.once('close',code=>{
        if(settled)return;settled=true;const durationMs=this.durationMs;finish();
        if(!this.stopRequested && code!==0){this.clear();reject(new Error('audio_capture_failed'));return;}
        const result=this.discard?Buffer.alloc(0):Buffer.concat(this.chunks,this.bytes);this.clear();this.completed=result;resolve(result);
        this.emit('stopped',{reason:this.stopReason,durationMs});
      });
    });
    // Failure remains observable even if the device closes before the user presses stop.
    void this.completion.catch(error=>this.emit('failure',error));
    this.timer=setTimeout(()=>this.requestStop('limit'),this.maxDurationMs);
    await new Promise<void>((resolve,reject)=>{
      const clean=()=>{child.off('spawn',onSpawn);child.off('error',onError);child.off('close',onClose);};
      const onSpawn=()=>{clean();resolve();};const onError=()=>{clean();reject(new Error('audio_capture_failed'));};const onClose=()=>{clean();reject(new Error('audio_capture_cancelled'));};
      child.once('spawn',onSpawn);child.once('error',onError);child.once('close',onClose);
    });
    if(epoch!==this.epoch||discovery.signal.aborted)throw new Error('audio_capture_cancelled');
    } finally {if(this.discovery===discovery){this.discovery=null;this.starting=false;}}
  }
  private requestStop(reason:'limit'|'requested'):void{
    const first=!this.stopRequested;this.stopRequested=true;
    if(first)this.stopReason=reason;
    if(this.timer)clearTimeout(this.timer);this.timer=null;
    this.child?.kill();
    if(first&&reason==='limit')this.emit('limit',{durationMs:this.durationMs});
  }
  async stop():Promise<Buffer>{
    this.epoch++;this.discovery?.abort();this.requestStop('requested');
    const completion=this.completion;
    try{return completion ? await completion : Buffer.alloc(0);}
    finally{if(this.completion===completion){this.completion=null;this.completed=null;}}
  }
  async cancel():Promise<void>{this.discard=true;this.completed?.fill(0);this.clear();const bytes=await this.stop().catch(()=>Buffer.alloc(0));bytes.fill(0);this.clear();}
  private clear():void{for(const chunk of this.chunks)chunk.fill(0);this.chunks=[];this.bytes=0;}
}

/** Plays generated PCM without creating a retained audio file. */
export function playPcm(pcm:Uint8Array,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();
  if(!pcm.length)return Promise.resolve();
  if(pcm.length%2||pcm.length>960000)return Promise.reject(new Error('audio_pcm_invalid'));
  const ffplay=resolveProgram('ffplay'),aplay=resolveProgram('aplay');
  let command:string,args:string[],input:Uint8Array;
  if(process.platform==='win32'){
    command=resolveProgram('powershell.exe') ?? 'powershell.exe';
    const script='$i=[Console]::OpenStandardInput();$m=New-Object System.IO.MemoryStream;$i.CopyTo($m);$m.Position=0;$p=New-Object System.Media.SoundPlayer($m);try{$p.PlaySync()}finally{$p.Dispose();$m.Dispose()}';
    args=['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')];input=pcmWav(pcm);
  }else if(ffplay){command=ffplay;args=['-nodisp','-autoexit','-loglevel','error','-f','s16le','-ar',String(AUDIO_RATE),'-ac','1','-i','pipe:0'];input=Buffer.from(pcm);}
  else if(aplay){command=aplay;args=['-q','-f','S16_LE','-r',String(AUDIO_RATE),'-c','1'];input=Buffer.from(pcm);}
  else return Promise.reject(new Error('audio_playback_unavailable'));
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{windowsHide:true,env:environment(),stdio:['pipe','ignore','ignore']});
    const cancel=()=>child.kill();signal?.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>{child.kill();reject(new Error('audio_playback_timeout'));},15000+pcm.length/48);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);input.fill(0);};
    child.stdin.on('error',()=>undefined);child.stdin.end(input);
    child.once('error',()=>{cleanup();reject(new Error('audio_playback_failed'));});
    child.once('close',code=>{cleanup();if(signal?.aborted)reject(signal.reason);else if(code!==0)reject(new Error('audio_playback_failed'));else resolve();});
  });
}

/** A single native output process per voice session avoids process startup per
 * packet. On Windows waveOut plays bounded frames from stdin entirely in RAM.
 * Acknowledgements arrive only after the hardware buffer has completed. */
export class PcmPlayer {
  private child:ReturnType<typeof spawn>|null=null;
  private chain:Promise<void>=Promise.resolve();
  private bytes=0;
  private pending:{resolve:()=>void;reject:(error:Error)=>void}|null=null;
  private epoch=0;
  private stopSignal=new AbortController();
  private retained=new Set<Buffer>();
  private open():void{
    if(this.child||process.platform!=='win32')return;
    const source=String.raw`using System; using System.IO; using System.Runtime.InteropServices; using System.Threading;
public class UtkAudio {
 [StructLayout(LayoutKind.Sequential,Pack=2)] struct Format {public ushort tag,channels; public uint rate,average; public ushort align,bits,extra;}
 [StructLayout(LayoutKind.Sequential)] struct Header {public IntPtr data; public uint length,recorded; public UIntPtr user; public uint flags,loops; public IntPtr next;public UIntPtr reserved;}
 [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr h,uint device,ref Format f,IntPtr callback,IntPtr instance,uint flags);
 [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr h,IntPtr header,uint size);
 [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr h,IntPtr header,uint size);
 [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr h,IntPtr header,uint size);
 [DllImport("winmm.dll")] static extern int waveOutReset(IntPtr h);
 [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr h);
 public static void Run(){IntPtr h;Format f=new Format{tag=1,channels=1,rate=24000,average=48000,align=2,bits=16};if(waveOutOpen(out h,0xffffffff,ref f,IntPtr.Zero,IntPtr.Zero,0)!=0)throw new Exception("audio_output_unavailable");
  try{var r=new BinaryReader(Console.OpenStandardInput());while(true){int length;try{length=r.ReadInt32();}catch(EndOfStreamException){break;}if(length<0||length>960000||length%2!=0)throw new Exception("audio_frame_invalid");if(length==0)continue;byte[] b=r.ReadBytes(length);if(b.Length!=length)throw new EndOfStreamException();var pin=GCHandle.Alloc(b,GCHandleType.Pinned);IntPtr ptr=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Header)));bool prepared=false;
   try{var header=new Header{data=pin.AddrOfPinnedObject(),length=(uint)length};Marshal.StructureToPtr(header,ptr,false);uint size=(uint)Marshal.SizeOf(typeof(Header));if(waveOutPrepareHeader(h,ptr,size)!=0)throw new Exception("audio_prepare_failed");prepared=true;if(waveOutWrite(h,ptr,size)!=0)throw new Exception("audio_write_failed");while((((Header)Marshal.PtrToStructure(ptr,typeof(Header))).flags&1)==0)Thread.Sleep(2);Console.WriteLine("played");Console.Out.Flush();}
   finally{if(prepared)waveOutUnprepareHeader(h,ptr,(uint)Marshal.SizeOf(typeof(Header)));Marshal.FreeHGlobal(ptr);pin.Free();Array.Clear(b,0,b.Length);}
  }}finally{waveOutReset(h);waveOutClose(h);}
 }
}`;
    const script=`Add-Type -TypeDefinition @'\n${source}\n'@;[UtkAudio]::Run()`;
    const child=spawn(resolveProgram('powershell.exe')??'powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:environment(),stdio:'pipe'});
    this.child=child;let response='';
    child.stdout?.on('data',(chunk:Buffer)=>{if(this.child!==child)return;response=(response+chunk.toString()).slice(-1024);if(response.includes('played')){response='';this.pending?.resolve();this.pending=null;}});
    child.stderr?.on('data',()=>undefined);child.stdin?.on('error',()=>undefined);
    const failed=()=>{if(this.child!==child)return;this.pending?.reject(new Error('audio_playback_failed'));this.pending=null;this.child=null;};
    child.once('error',failed);child.once('close',failed);
  }
  play(pcm:Uint8Array,signal?:AbortSignal):Promise<void>{
    signal?.throwIfAborted();
    if(!pcm.length)return Promise.resolve();
    if(pcm.length%2||pcm.length>960000||this.bytes+pcm.length>1920000)return Promise.reject(new Error('audio_playback_queue_full'));
    const data=Buffer.from(pcm),epoch=this.epoch;this.bytes+=data.length;this.retained.add(data);
    const playSignal=signal?AbortSignal.any([signal,this.stopSignal.signal]):this.stopSignal.signal;
    const task=this.chain.catch(()=>undefined).then(async()=>{
      playSignal.throwIfAborted();if(epoch!==this.epoch)throw new Error('audio_playback_cancelled');
      if(process.platform!=='win32')return playPcm(data,playSignal);
      this.open();
      const cancel=()=>{if(epoch===this.epoch)this.stop();};playSignal.addEventListener('abort',cancel,{once:true});
      try{await new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>{this.stop();reject(new Error('audio_playback_timeout'));},15000+data.length/48);
        this.pending={resolve:()=>{clearTimeout(timeout);resolve();},reject:error=>{clearTimeout(timeout);reject(error);}};
        const size=Buffer.alloc(4);size.writeInt32LE(data.length);this.child!.stdin!.write(size);this.child!.stdin!.write(data);
      });}finally{playSignal.removeEventListener('abort',cancel);}
    }).finally(()=>{this.bytes-=data.length;data.fill(0);this.retained.delete(data);});
    this.chain=task;return task;
  }
  stop():void{this.epoch++;const abort=this.stopSignal;this.stopSignal=new AbortController();const child=this.child;this.child=null;this.pending?.reject(new Error('audio_playback_cancelled'));this.pending=null;for(const data of this.retained)data.fill(0);abort.abort(new Error('audio_playback_cancelled'));child?.kill();}
}
