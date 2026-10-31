// A virtual, read-only address for a durable attachment, independent of its store.
export const PREVIEW_ROOT = '/__uptokey_attachment__/';
export function attachmentPreviewPath(ref) {
  if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
    || typeof ref.name !== 'string' || !ref.name || ref.name === '.' || ref.name === '..'
    || /[\\/\u0000-\u001f\u007f<>:"|?*]/.test(ref.name)
    || ref.name !== ref.name.trim() || /[. ]$/.test(ref.name)
    || new TextEncoder().encode(ref.name).length > 255) throw Error('attachment_preview_invalid');
  return PREVIEW_ROOT + ref.bytes + '/' + ref.attachmentId.slice(7) + '/' + ref.name;
}
export function attachmentPreviewReference(path) {
  if (typeof path !== 'string' || !path.startsWith(PREVIEW_ROOT)) return null;
  const match = /^(0|[1-9][0-9]*)\/([a-f0-9]{64})\/([^/]+)$/.exec(path.slice(PREVIEW_ROOT.length));
  if (!match) throw Error('attachment_preview_invalid');
  const ref = {bytes: Number(match[1]), attachmentId: 'sha256:' + match[2], name: match[3]};
  if (attachmentPreviewPath(ref) !== path) throw Error('attachment_preview_invalid');
  return ref;
}
