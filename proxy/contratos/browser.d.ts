export const BROWSER_READ_CONTRACT_VERSION: 1;
export interface BrowserReadRequest {readonly schemaVersion:1;readonly url:string;}
export function parseBrowserReadRequest(input:unknown):Readonly<BrowserReadRequest>;
export function canonicalBrowserReadPayload(input:unknown):string;
export const BROWSER_FILL_CONTRACT_VERSION:1;
export interface BrowserFillRequest {readonly schemaVersion:1;readonly url:string;readonly fields:readonly {readonly label:string;readonly value:string}[];}
export function parseBrowserFillRequest(input:unknown):Readonly<BrowserFillRequest>;
export function canonicalBrowserFillPayload(input:unknown):string;
