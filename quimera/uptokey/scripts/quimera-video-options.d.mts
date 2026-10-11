export interface VideoProfile {model:string;endpoint:string;imageOrigins?:string[];}
export function parseVideoCliArguments(args:readonly string[]):VideoProfile|undefined;
export function validateVideoProfile(input:VideoProfile):VideoProfile;

