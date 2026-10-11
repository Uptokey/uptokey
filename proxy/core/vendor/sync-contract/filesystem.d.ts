export const FILESYSTEM_READ_CONTRACT_VERSION: 1;
export type FilesystemReadTool = 'list_directory' | 'get_file_info' | 'read_text_file';
export const FILESYSTEM_READ_TOOLS: readonly FilesystemReadTool[];
export const FILESYSTEM_TEXT_MAX_LINES: 1000;
export type FilesystemDiagnostic = 'mcp_config_invalid' | 'mcp_package_invalid' | 'mcp_discovery_invalid' |
  'mcp_tool_missing' | 'mcp_schema_unexpected' | 'mcp_discovery_failed';
export const FILESYSTEM_DIAGNOSTICS: readonly FilesystemDiagnostic[];
export interface FilesystemReadRequest {
  readonly schemaVersion: 1;
  readonly tool: FilesystemReadTool;
  readonly relativePath: string;
  /** Required for read_text_file only: first N lines, 1..FILESYSTEM_TEXT_MAX_LINES. */
  readonly lineLimit?: number;
  readonly profileDigest: string;
  readonly schemaDigest: string;
}
export function parseFilesystemReadRequest(input: unknown): Readonly<FilesystemReadRequest>;
export function canonicalFilesystemReadPayload(input: unknown): string;
export interface FilesystemCatalogLimits {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
  readonly maxLines: number;
}
interface FilesystemCatalogBase {
  readonly available: boolean;
  readonly profileDigest: string | null;
  readonly tools: readonly { readonly name: FilesystemReadTool; readonly schemaDigest: string }[];
}
export interface FilesystemCatalogV1 extends FilesystemCatalogBase { readonly schemaVersion: 1 }
export interface FilesystemCatalogV2 extends FilesystemCatalogBase {
  readonly schemaVersion: 2;
  readonly status: 'available' | 'not_configured' | 'discovery_failed';
  readonly diagnostic: FilesystemDiagnostic | null;
  readonly limits: FilesystemCatalogLimits | null;
}
export type FilesystemCatalog = FilesystemCatalogV1 | FilesystemCatalogV2;
export function parseFilesystemCatalog(input: unknown): Readonly<FilesystemCatalog>;
