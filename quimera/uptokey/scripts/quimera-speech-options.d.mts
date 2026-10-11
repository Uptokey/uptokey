export interface SpeechProfile {model:string;endpoint:string;}
export function parseSpeechCliArguments(args:readonly string[]):SpeechProfile|undefined;
export function validateSpeechProfile(input:SpeechProfile):SpeechProfile;
