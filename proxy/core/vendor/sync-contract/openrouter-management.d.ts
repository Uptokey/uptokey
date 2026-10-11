export declare const MANAGEMENT_KEY_COMMANDS: readonly ['create', 'list', 'get', 'update', 'disable', 'delete'];
export type ManagementKeyCommand =
  | Readonly<{ kind: 'create'; operationId: string; name: string; expiresAt?: string | null; limit?: number | null; limitReset?: 'daily' | 'weekly' | 'monthly' | null; includeByokInLimit?: boolean }>
  | Readonly<{ kind: 'list'; operationId: string }>
  | Readonly<{ kind: 'get' | 'disable' | 'delete'; operationId: string; remoteKeyHash: string }>
  | Readonly<{ kind: 'update'; operationId: string; remoteKeyHash: string; name?: string; limit?: number | null; includeByokInLimit?: boolean; disabled?: boolean }>;
export function parseManagementKeyCommand(input: unknown): ManagementKeyCommand;
