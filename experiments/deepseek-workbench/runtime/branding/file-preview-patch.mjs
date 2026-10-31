import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Checked adaptation of the pinned distribution, keeping its Factory, markup,
// locale and Sidebar resource owner. Upstream source and licenses stay intact.
export function patchAttachmentPreview(source) {
  const once = (before, after) => {
    assert.equal(source.split(before).length, 2, 'Attachment preview pinned contract changed');
    source = source.replace(before, after);
  };
  const contract = readFileSync(new URL('../contracts/file-preview.mjs', import.meta.url), 'utf8').replaceAll('export ', '');
  once('function UserContent({ content, loadImage,', contract + '\nfunction UserContent({ openAttachment, content, loadImage,');
  once('}) }, `image:${index}`) : (0, react_jsx_runtime.jsxs)("span", {',
    '}) }, `image:${index}`) : (0, react_jsx_runtime.jsxs)("button", {\n' +
    'type: "button", onClick: () => openAttachment(attachment.file),\n' +
    'style: {cursor: "pointer", color: "inherit", font: "inherit", textAlign: "start"},\n');
  const seat = 'name: "conversation.chat.user.content",';
  once(seat, seat + `
    inject: (sessionId) => ({openAttachment: (ref) => {
      const path = attachmentPreviewPath(ref);
      ctx.sidebarRight.openResource(fileAddressFor(sessionId, undefined, path));
    }}),`);
  return source;
}
