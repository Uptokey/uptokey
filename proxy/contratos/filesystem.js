import { isDataRecord } from './plain-data.js';
import { canonicalJson } from './canonical.js';
export const FILESYSTEM_READ_CONTRACT_VERSION = 1;
export const FILESYSTEM_READ_TOOLS = Object.freeze(['list_directory', 'get_file_info', 'read_text_file']);
/** Upper bound for the line window of a text read; bytes are bounded separately by the plan. */
export const FILESYSTEM_TEXT_MAX_LINES = 1000;
export const FILESYSTEM_DIAGNOSTICS = Object.freeze(['mcp_config_invalid', 'mcp_package_invalid', 'mcp_discovery_invalid',
  'mcp_tool_missing', 'mcp_schema_unexpected', 'mcp_discovery_failed']);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const pathOk = value => typeof value === 'string' && value.length <= 2048 &&
  (value === '.' || !value.split(/[\\/]/).some(part =>
    !part || part === '.' || part === '..' || /[\x00-\x1f:<>"|?*]/.test(part) || /[. ]$/.test(part)));
/** A proposed read, not permission to start a process or access a directory. */
export function parseFilesystemReadRequest(input) {
  const invalid = () => { throw new Error('filesystem_read_invalid'); };
  if (!isDataRecord(input) || !FILESYSTEM_READ_TOOLS.includes(input.tool)) invalid();
  const text = input.tool === 'read_text_file';
  if (Object.keys(input).sort().join(',') !== (text ? 'lineLimit,' : '') + 'profileDigest,relativePath,schemaDigest,schemaVersion,tool' ||
      input.schemaVersion !== 1 || !digest(input.profileDigest) || !digest(input.schemaDigest) || !pathOk(input.relativePath) ||
      (text && (!Number.isSafeInteger(input.lineLimit) || input.lineLimit < 1 || input.lineLimit > FILESYSTEM_TEXT_MAX_LINES))) invalid();
  return Object.freeze({schemaVersion:1,tool:input.tool,relativePath:input.relativePath,
    ...(text ? {lineLimit:input.lineLimit} : {}),profileDigest:input.profileDigest,schemaDigest:input.schemaDigest});
}
export function canonicalFilesystemReadPayload(input) { return canonicalJson(parseFilesystemReadRequest(input)); }

/**
 * Public projection of an explicitly configured profile; no paths or executable schema.
 * Version 1 is still accepted for cached clients; producers emit version 2.
 */
export function parseFilesystemCatalog(input) {
  const invalid = () => { throw new Error('filesystem_catalog_invalid'); };
  if (!isDataRecord(input) || (input.schemaVersion !== 1 && input.schemaVersion !== 2)) invalid();
  const v2 = input.schemaVersion === 2;
  if (Object.keys(input).sort().join(',') !== (v2 ? 'available,diagnostic,limits,profileDigest,schemaVersion,status,tools' : 'available,profileDigest,schemaVersion,tools') ||
      typeof input.available !== 'boolean' || !Array.isArray(input.tools) || input.tools.length > FILESYSTEM_READ_TOOLS.length) invalid();
  if (input.available ? !digest(input.profileDigest) : input.profileDigest !== null || input.tools.length !== 0) invalid();
  const names = new Set();
  const tools = input.tools.map(tool => {
    if (!isDataRecord(tool) || Object.keys(tool).sort().join(',') !== 'name,schemaDigest' ||
        !FILESYSTEM_READ_TOOLS.includes(tool.name) || (!v2 && tool.name === 'read_text_file') || names.has(tool.name) ||
        !digest(tool.schemaDigest)) invalid();
    names.add(tool.name);
    return Object.freeze({name:tool.name,schemaDigest:tool.schemaDigest});
  });
  if (input.available && tools.length === 0) invalid();
  if (!v2) return Object.freeze({schemaVersion:1,available:input.available,profileDigest:input.profileDigest,tools:Object.freeze(tools)});
  const status = input.status;
  if (!['available', 'not_configured', 'discovery_failed'].includes(status) || input.available !== (status === 'available') ||
      (status === 'discovery_failed' ? !FILESYSTEM_DIAGNOSTICS.includes(input.diagnostic) : input.diagnostic !== null)) invalid();
  let limits = null;
  if (input.available) {
    const value = input.limits;
    if (!isDataRecord(value) || Object.keys(value).sort().join(',') !== 'maxLines,maxOutputBytes,timeoutMs' ||
        !Number.isSafeInteger(value.maxOutputBytes) || value.maxOutputBytes < 1 || value.maxOutputBytes > 1024 * 1024 ||
        !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 600_000 ||
        !Number.isSafeInteger(value.maxLines) || value.maxLines < 1 || value.maxLines > FILESYSTEM_TEXT_MAX_LINES) invalid();
    limits = Object.freeze({maxOutputBytes:value.maxOutputBytes,timeoutMs:value.timeoutMs,maxLines:value.maxLines});
  } else if (input.limits !== null) invalid();
  return Object.freeze({schemaVersion:2,available:input.available,status,diagnostic:input.diagnostic,
    profileDigest:input.profileDigest,tools:Object.freeze(tools),limits});
}
