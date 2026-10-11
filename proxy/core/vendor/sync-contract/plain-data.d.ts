export function isDataRecord(value: unknown): value is Record<string, unknown>;
export function asDataRecord(value: unknown): Record<string, unknown> | undefined;
export function projectDataArray(value: unknown, maximum: number): unknown[] | undefined;
export function projectStringArray(value: unknown, maximum: number): string[] | undefined;
