// Shared by host orchestration and the short controller-side Node operation.
// All lease mutations are serialized; neither a stale owner nor cleanup may
// disable another selection. No capability is returned or logged.
export function computerSessionLease(input, { fs, crypto, YAML, paths = {}, now = Date.now() }) {
  const statePath = paths.state ?? '/tmp/uptokey-computer-session.json';
  const lockPath = paths.lock ?? '/tmp/uptokey-computer-session.lock';
  const keyPath = paths.key ?? '/home/node/.ssh/uptokey-computer-authorized-keys';
  const sshPath = paths.ssh ?? '/home/node/.ssh';
  const profilePath = paths.profile ?? '/home/node/.dsh/profiles/web/cordis.patch.yml';
  const hash = text => crypto.createHash('sha256').update(text).digest('hex');
  const valid = value => value && Object.keys(value).length === 6
    && /^[a-f0-9]{64}$/.test(value.capability) && /^[a-f0-9]{32}$/.test(value.id)
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
    && value.port === 43196 && value.schema === 'uptokey.computer.session.v1'
    && /^[a-f0-9]{64}$/.test(value.publicKeySha256);
  if (!['claim', 'publish', 'revoke'].includes(input.operation) || !valid(input.state)) throw Error('Invalid computer lease request');
  const readPrivate = path => {
    const stat = fs.lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw Error('Invalid private computer lease file');
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 4096) throw Error('Computer lease changed');
      return fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  };
  const readState = () => {
    if (!fs.existsSync(statePath)) return null;
    const state = JSON.parse(readPrivate(statePath));
    // Legacy descriptors without the public identity hash cannot authorize
    // deletion of either a forwarding identity or a profile entry.
    if (!valid(state)) throw Error('Computer lease requires explicit legacy recovery');
    return state;
  };
  const same = (a, b) => a?.id === b.id && a?.capability === b.capability && a?.publicKeySha256 === b.publicKeySha256;
  const checkKey = state => {
    if (!fs.existsSync(keyPath)) return false;
    if (hash(readPrivate(keyPath)) !== state.publicKeySha256) throw Error('Computer forwarding identity changed');
    return true;
  };
  const profile = (state, publish) => {
    const before = fs.readFileSync(profilePath, 'utf8'), doc = YAML.parse(before);
    if (!Array.isArray(doc)) throw Error('Invalid original profile');
    const plugins = doc.flatMap(patch => patch.insert ?? []).filter(plugin => plugin.id === 'uptokey-computer');
    if (plugins.length > 1) throw Error('Ambiguous computer profile');
    const current = plugins[0];
    let changed = false;
    if (publish) {
      const plugin = { id: 'uptokey-computer', name: '@deepseek-ai/dsh-mcp-client', disabled: false, config: { serverName: 'computer', transport: 'stdio', command: 'node', args: ['/opt/integrations/computer-relay.mjs', state.id], failOnStartupError: false, toolCallTimeoutMs: 30000 } };
      if (current) Object.assign(current, plugin); else doc.push({ insert: [plugin] });
      changed = true;
    } else if (current?.config?.args?.[0] === '/opt/integrations/computer-relay.mjs' && current.config.args[1] === state.id && current.config.args.length === 2 && !current.disabled) {
      current.disabled = true;
      changed = true;
    }
    if (changed) {
      if (fs.readFileSync(profilePath, 'utf8') !== before) throw Error('Concurrent profile change');
      fs.writeFileSync(profilePath, YAML.stringify(doc));
    }
  };
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch { throw Error('Computer lease operation already in progress'); }
  const lockIdentity = fs.fstatSync(lock);
  try {
    let current = readState();
    if (input.operation === 'claim') {
      if (input.state.expiresAt <= now || input.state.expiresAt > now + 16 * 60_000) throw Error('Invalid computer lease expiry');
      if (typeof input.key !== 'string' || input.key.length > 4096 || hash(input.key) !== input.state.publicKeySha256) throw Error('Invalid forwarding identity');
      const directory = fs.lstatSync(sshPath);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw Error('Invalid laboratory SSH directory');
      if (current) {
        if (current.expiresAt > now) throw Error('Another computer selection is still active');
        const hasKey = checkKey(current);
        profile(current, false);
        if (hasKey) { checkKey(current); fs.unlinkSync(keyPath); }
        if (!same(readState(), current)) throw Error('Computer lease ownership changed');
        fs.unlinkSync(statePath);
      } else if (fs.existsSync(keyPath)) {
        throw Error('Unowned computer forwarding identity requires explicit recovery');
      }
      fs.writeFileSync(statePath, JSON.stringify(input.state), { flag: 'wx', mode: 0o600 });
      try { fs.writeFileSync(keyPath, input.key, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (same(readState(), input.state)) fs.unlinkSync(statePath); throw error; }
      return { claimed: true };
    }
    if (!same(current, input.state)) return { owned: false };
    const hasKey = checkKey(current);
    if (input.operation === 'publish') {
      if (!hasKey || current.expiresAt <= now) throw Error('Computer lease unavailable');
      profile(current, true);
      return { published: true };
    }
    profile(current, false);
    if (hasKey) { checkKey(current); fs.unlinkSync(keyPath); }
    // Keep the lease until profile/key cleanup finishes. The exclusive lock
    // also prevents a new claim from interleaving with this final unlink.
    if (!same(readState(), current)) throw Error('Computer lease ownership changed');
    fs.unlinkSync(statePath);
    return { revoked: true };
  } finally {
    fs.closeSync(lock);
    try {
      const current = fs.lstatSync(lockPath);
      if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino && !current.isSymbolicLink()) fs.unlinkSync(lockPath);
    } catch {}
  }
}

export const computerSessionLeaseProgram = `const fs=require('node:fs'),crypto=require('node:crypto'),YAML=require('/opt/harness/node_modules/yaml');(${computerSessionLease.toString()})(JSON.parse(fs.readFileSync(0,'utf8')),{fs,crypto,YAML});`;
