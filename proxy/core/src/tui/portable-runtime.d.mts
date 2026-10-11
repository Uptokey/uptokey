export const NATIVE_TARGETS: readonly string[];
export const BUN_PACKAGE_TARGETS: Readonly<Record<string, string>>;
export function portableDependencies(info: { platform: string; runtime: string; bun: string; nativePackage: string }): { dependencies: Record<string, string>; optionalDependencies: Record<string, string> };
export function nativeTarget(platform?: string, arch?: string, glibc?: string): string;
export function resolvePortableRuntime(artifact: string, target?: string): { runtime: string; env: Record<string, string> };
