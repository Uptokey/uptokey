export interface EmbeddingsProfile {model:string;endpoint:string;}
export function validateEmbeddingsProfile(input:EmbeddingsProfile):EmbeddingsProfile;
export function parseEmbeddingsCliArguments(args:readonly string[]):EmbeddingsProfile|undefined;
