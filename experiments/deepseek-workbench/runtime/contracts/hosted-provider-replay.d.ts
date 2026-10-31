export type HostedProviderReplay = Readonly<{kind:'vertex-content-v1';parts:readonly Record<string,unknown>[];callIds:readonly string[]}>;
export function parseHostedProviderReplay(value:unknown,content:string,calls?:readonly {id:string;name:string;arguments:string}[],allowAdditionalText?:boolean):HostedProviderReplay|null|undefined;
