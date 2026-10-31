import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm, lstat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {attachmentPreviewPath, attachmentPreviewReference, PREVIEW_ROOT} from '../contracts/file-preview.mjs';
import {installAttachmentPreview} from './attachment-preview.mjs';
import {patchAttachmentPreview} from '../branding/file-preview-patch.mjs';

const ref = {attachmentId: 'sha256:' + 'a'.repeat(64), name: 'relatório #1.csv', bytes: 35};
test('reference roundtrip preserves Unicode, filename and exact byte count', () => {
  assert.deepEqual(attachmentPreviewReference(attachmentPreviewPath(ref)), ref);
  assert.equal(attachmentPreviewReference('/workspace/other.csv'), null);
});
test('invalid and traversal addresses fail before reaching the provider', async () => {
  let called = false;
  const fs = {resolve: async () => { called = true; }};
  const adapter = installAttachmentPreview(fs, {fileHostPath() { called = true; }});
  for (const path of [PREVIEW_ROOT + '../x', PREVIEW_ROOT + '01/' + 'a'.repeat(64) + '/a.csv',
    PREVIEW_ROOT + '9007199254740992/' + 'a'.repeat(64) + '/a.csv',
    PREVIEW_ROOT + '1/' + 'a'.repeat(64) + '/..', PREVIEW_ROOT + '1/' + 'a'.repeat(64) + '/a\\b']) {
    await assert.rejects(fs.resolve(path), {code: 'FS_NOT_FOUND'});
  }
  assert.equal(called, false); adapter.dispose();
});
test('same reference follows the selected provider and reads bytes, preserving cancellation and unload', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-preview-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const legacy = join(root, 'legacy.csv'), encrypted = join(root, 'materialized.csv');
  await writeFile(legacy, 'legacy'); await writeFile(encrypted, 'decrypted');
  let selected = legacy;
  const fs = {async resolve(path, options) { options.signal.throwIfAborted(); assert.equal(this, fs); return path; }};
  const original = fs.resolve, seen = [];
  const adapter = installAttachmentPreview(fs, {fileHostPath(value) { seen.push(value); return selected; }});
  const options = {signal: new AbortController().signal};
  assert.equal(await readFile(await fs.resolve(attachmentPreviewPath(ref), options), 'utf8'), 'legacy');
  selected = encrypted;
  assert.equal(await readFile(await fs.resolve(attachmentPreviewPath(ref), options), 'utf8'), 'decrypted');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(fs.resolve(attachmentPreviewPath(ref), {signal: abort.signal}), {name: 'AbortError'});
  assert.deepEqual(seen[0], ref);
  assert.equal(await fs.resolve('/workspace/ordinary.txt', options), '/workspace/ordinary.txt');
  adapter.dispose(); assert.equal(fs.resolve, original);
});
test('late disposal does not overwrite a newer wrapper; captured callback becomes a passthrough', async () => {
  const fs = {resolve: async path => path};
  const adapter = installAttachmentPreview(fs, {fileHostPath: () => '/resolved.csv'});
  const captured = fs.resolve, replacement = async path => captured(path);
  fs.resolve = replacement; adapter.dispose();
  assert.equal(fs.resolve, replacement);
  assert.equal(await fs.resolve(attachmentPreviewPath(ref)), attachmentPreviewPath(ref));
});
test('preview metadata maps its reference without resolving before the no-follow inspection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-preview-stat-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const path = join(root, 'cold.csv'), order = [];
  await writeFile(path, 'prepared');
  const fs = {
    async resolve(value, options) { options.signal.throwIfAborted(); order.push('resolve'); await writeFile(value, 'prepared'); return value; },
    async lstat(value, options, signal) { signal.throwIfAborted(); order.push('lstat'); return lstat(value); },
  };
  const original = fs.lstat, abort = new AbortController();
  const adapter = installAttachmentPreview(fs, {fileHostPath: () => path});
  const info = await fs.lstat(attachmentPreviewPath(ref), {cwd:'/workspace'}, abort.signal);
  assert.equal(info.isFile(), true); assert.equal(info.size, 8); assert.deepEqual(order, ['lstat']);
  abort.abort(); await assert.rejects(fs.lstat(attachmentPreviewPath(ref), {}, abort.signal), {name:'AbortError'});
  await assert.rejects(fs.lstat(PREVIEW_ROOT+'../invalid', {}, new AbortController().signal), {code:'FS_NOT_FOUND'});
  adapter.dispose(); assert.equal(fs.lstat, original);
});
test('pinned user file card becomes an accessible button opening the original resource in its session', () => {
  const path = '/opt/harness/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js';
  const before = readFileSync(path, 'utf8');
  const source = before.includes('function UserContent({ openAttachment,') ? before : patchAttachmentPreview(before);
  const start = source.indexOf('const PREVIEW_ROOT ='), end = source.indexOf('//#endregion', start);
  const jsx = (type, props) => ({type, props});
  const sandbox = {TextEncoder, react_jsx_runtime: {jsx, jsxs: jsx}, react: {Fragment: 'fragment'},
    MessageItem_module_css_default: {}, EMPTY_LABELS: [],
    _deepseek_ai_dsh_client_ui_primitives: {FileTypeIcon: 'icon', fileExtension: () => 'csv', fileSizeText: n => String(n)}};
  vm.createContext(sandbox); vm.runInContext(source.slice(start, end) + ';this.component = UserContent;', sandbox);
  let opened;
  const result = sandbox.component({openAttachment: value => {opened = value;}, content: {text: '', attachments: [{type:'file',file:ref}], extraBlocks:[]}, t: k => k});
  const button = result.props.children[0].props.children[0];
  assert.equal(button.type, 'button'); assert.equal(button.props.type, 'button');
  assert.equal(button.props.title, ref.name); button.props.onClick(); assert.equal(opened, ref);
  const marker = 'name: "conversation.chat.user.content",';
  const injection = source.slice(source.indexOf(marker) + marker.length).split('scope: "session"')[0];
  let address;
  sandbox.ctx = {sidebarRight: {openResource(value) { address = value; }}};
  sandbox.fileAddressFor = (sessionId, cwd, path) => ({sessionId, cwd, path});
  vm.runInContext('this.injected = ({' + injection + '}).inject("session-a")', sandbox);
  sandbox.injected.openAttachment(ref);
  assert.equal(address.sessionId, 'session-a'); assert.equal(address.path, attachmentPreviewPath(ref));
  assert.throws(() => patchAttachmentPreview('unexpected distribution'));
});
