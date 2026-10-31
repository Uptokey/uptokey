import {symbols} from '@deepseek-ai/cordis';
import {FsError} from '@deepseek-ai/dsh-fs';
import {attachmentPreviewReference} from '../contracts/file-preview.mjs';

// Keep auth, cancellation, hydration and byte reads in the original filesystem.
// The virtual path changes addressing only; it does not materialize or cache bytes.
export function installAttachmentPreview(filesystem, attachments) {
  const target = filesystem[symbols.original] ?? filesystem;
  const descriptor = Object.getOwnPropertyDescriptor(target, 'resolve');
  const original = target.resolve;
  const statDescriptor = Object.getOwnPropertyDescriptor(target, 'lstat');
  const originalStat = target.lstat;
  if (typeof original !== 'function' || typeof attachments.fileHostPath !== 'function') throw Error('attachment_preview_contract');
  let active = true;
  const wrapped = function(path, ...args) {
    if (!active) return original.call(this, path, ...args);
    let ref;
    try { ref = attachmentPreviewReference(path); }
    catch { return Promise.reject(new FsError('Invalid attachment address.', 'FS_NOT_FOUND')); }
    if (ref !== null) {
      try { path = attachments.fileHostPath(ref); }
      catch { return Promise.reject(new FsError('Attachment unavailable.', 'FS_NOT_FOUND')); }
    }
    return original.call(this, path, ...args);
  };
  const wrappedStat = async function(path, options, signal) {
    if (!active) return originalStat.call(this, path, options, signal);
    let ref;
    try { ref = attachmentPreviewReference(path); }
    catch { throw new FsError('Invalid attachment address.', 'FS_NOT_FOUND'); }
    if (ref !== null) {
      try { path = attachments.fileHostPath(ref); }
      catch { throw new FsError('Attachment unavailable.', 'FS_NOT_FOUND'); }
      // The shared filesystem owner prepares cold paths at lstat itself.
      // Keep this adapter limited to addressing, without a second resolve/read.
    }
    return originalStat.call(this, path, options, signal);
  };
  Object.defineProperty(target, 'resolve', {value: wrapped, writable: true, configurable: true});
  if (typeof originalStat === 'function') Object.defineProperty(target, 'lstat', {value: wrappedStat, writable: true, configurable: true});
  return {dispose() {
    active = false;
    if (Object.getOwnPropertyDescriptor(target, 'resolve')?.value === wrapped) {
      if (descriptor) Object.defineProperty(target, 'resolve', descriptor); else delete target.resolve;
    }
    if (Object.getOwnPropertyDescriptor(target, 'lstat')?.value === wrappedStat) {
      if (statDescriptor) Object.defineProperty(target, 'lstat', statDescriptor); else delete target.lstat;
    }
  }};
}
