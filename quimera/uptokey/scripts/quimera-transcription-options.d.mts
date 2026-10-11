export interface TranscriptionProfile {model:string;endpoint:string;}
export function parseTranscriptionCliArguments(args:readonly string[]):TranscriptionProfile|undefined;
export function validateTranscriptionProfile(input:TranscriptionProfile):TranscriptionProfile;
