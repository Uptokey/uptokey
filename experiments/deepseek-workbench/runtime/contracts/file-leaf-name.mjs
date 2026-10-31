// Selected unchanged name algorithm from DeepSeek Harness0.2.1-rc.2 (MIT).
// Source: upstream/packages/attachment/attachment-local/src/file-store.ts
// Source SHA256: 8826c8ea6124c489c51c10bdc195f4f454b89370929e5d83c50e6232b2eef958; only TypeScript annotations removed.
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

function isWindowsDeviceName(name) {
  const dot = name.indexOf('.')
  const stem = (dot < 0 ? name : name.slice(0, dot)).replace(/[. ]+$/u, '')
  return WINDOWS_DEVICE_NAME.test(stem)
}

function utf8Prefix(value, maxBytes) {
  let bytes = 0
  let prefix = ''
  for (const character of Buffer.from(value).toString('utf8')) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

/**
 * Sanitize one caller display name into a safe stored leaf name. Both
 * separator styles are stripped by hand: a POSIX host treats `\` as an
 * ordinary character, so path.basename would keep a Windows client's full
 * local path and leak it into the reference and the session log. Characters
 * Windows refuses in file names become `_` so one reference stays valid on
 * every supported host.
 * @param value - caller-declared display name, possibly a full client path.
 * @returns a non-empty leaf name safe to store on every supported filesystem.
 */
export function fileLeafName(value) {
  if (value === undefined) return 'file'
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  let clean = leaf
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/u, '')
  if (isWindowsDeviceName(clean)) clean = `_${clean}`
  clean = utf8Prefix(clean, 255).replace(/[. ]+$/u, '')
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean
}

