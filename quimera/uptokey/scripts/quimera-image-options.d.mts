export interface ImageProfile {model:string;endpoint:string;editEndpoint?:string;}
export function parseImageCliArguments(args:readonly string[]):ImageProfile|undefined;
export function validateImageProfile(input:ImageProfile):ImageProfile;
