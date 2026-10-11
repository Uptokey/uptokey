export function defaultDistributionOutput(platform?: NodeJS.Platform): string;
export function compileDistributionCli(outputPath?: string): string;
export function resolveBunCompiler(): string;
export function publicDistributionCompileError(error: unknown): string;
export function shouldRetryDistributionExecution(platform: string, retries: number, result: { status?: number | null; error?: { code?: string }; signal?: unknown; stderr?: unknown }): boolean;
export function shouldRecompileDistributionExecution(result: { status?: number | null; error?: { code?: string }; signal?: unknown; stderr?: unknown }): boolean;
export function isWindowsDeviceGuardExecutionBlock(platform: string, retries: number, result: { status?: number | null; error?: { code?: string; errno?: number }; signal?: unknown; stderr?: unknown }): boolean;
export const DISTRIBUTION_EXECUTION_RETRY_DELAY_MS: 250;
