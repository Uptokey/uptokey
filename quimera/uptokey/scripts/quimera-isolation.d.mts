export const QUIMERA_ROOT: string | undefined;
export function developmentProductRoot(moduleUrl: string): string;
export function productCodeRoots(root?: string): Readonly<{CORE: string; INTEGRATIONS: string}>;
export function declaredCodeRoots(workspaceRoot: string, manifest: unknown): Readonly<{CORE: string; INTEGRATIONS: string}>;
export const PLAYWRIGHT_MCP_REVISION: string;
export function parseCompositionCliArguments(args: readonly string[]): 'langgraph' | undefined;
export interface LangGraphCompositionRuntime {
  readonly stateRoot: string;
  readonly graphEntry: string;
  readonly saverEntry: string;
  readonly traceableEntry: string;
  readonly nativeAddon: string;
  readonly workerEntry: string;
  readonly versions: Readonly<Record<string, string>>;
}
export function inspectCompositionRuntime(root?: string): LangGraphCompositionRuntime;
export function parseLangfuseEndpoint(value: unknown): string;
export type TelemetryStart = {readonly kind:'start';readonly driver:'langfuse'} | {readonly kind:'start';readonly driver:'collector-local';readonly endpoint:string};
export function parseTelemetryCliArguments(args: readonly string[]): TelemetryStart | { readonly kind: 'configure'; readonly endpoint: string } | undefined;
export function parseCollectorEndpoint(value:unknown):string;
export interface PlaywrightBrowserOptions {
  readonly driver: 'playwright-mcp';
  readonly allowedOrigin: string;
  readonly executablePath?: string;
}
export interface PlaywrightBrowserRuntime {
  readonly allowedOrigin: string;
  readonly appRoot: string;
  readonly stateRoot: string;
  readonly browsersPath: string;
  readonly executablePath: string;
  readonly entry: string;
  readonly coreEntry: string;
  readonly initPage: string;
}
export function parseBrowserArguments(args: readonly string[]): PlaywrightBrowserOptions | undefined;
export function browserArguments(options: PlaywrightBrowserOptions): string[];
export function inspectBrowserRuntime(options: PlaywrightBrowserOptions, root?: string): PlaywrightBrowserRuntime;
export function confinedPath(path: string, root?: string): string;
export function assertNoEnvFiles(root?: string, directories?: string[]): void;
export function isolatedChildEnv(inherited?: NodeJS.ProcessEnv, root?: string): Record<string, string>;
