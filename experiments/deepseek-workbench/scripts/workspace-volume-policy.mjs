import {randomUUID} from 'node:crypto';

// v1 remains untouched as the protected rollback for the first encrypted activation.
export const LEGACY_WORKSPACE_VOLUME = 'uptokey-deepseek-workbench-workspace';
export const WORKSPACE_VOLUME = 'uptokey-deepseek-workbench-workspace-v2';
export const WORKSPACE_POLICY = 'encrypted-tmpfs-v1';
export const WORKSPACE_VOLUME_OPTIONS = 'uid=1000,gid=1000,mode=0700,size=512m,nosuid,nodev,noswap';
const owner = 'io.uptokey.experiment=deepseek-workbench';

function optionSet(value) { return new Set(String(value ?? '').split(',').filter(Boolean)); }

export function workspaceVolumeArguments() { return ['-v', `${WORKSPACE_VOLUME}:/workspace:nocopy`]; }

export function assertWorkspaceVolume(value, expectedName = WORKSPACE_VOLUME) {
  const options = value?.Options ?? {}, flags = optionSet(options.o);
  if (value?.Name !== expectedName || value.Driver !== 'local' || value.Scope !== 'local'
    || value.Labels?.['io.uptokey.experiment'] !== 'deepseek-workbench'
    || options.type !== 'tmpfs' || options.device !== 'tmpfs'
    || !['uid=1000', 'gid=1000', 'mode=0700', 'size=512m', 'nosuid', 'nodev', 'noswap'].every(flag => flags.has(flag))) {
    throw Error('workspace_volume_policy_invalid');
  }
  return value;
}

/** Mount a throwaway volume with the exact workspace policy before creating persistent runtime containers. */
export function preflightWorkspaceMount(image, operations, {id = randomUUID()} = {}) {
  if (typeof image !== 'string' || !image || !/^[0-9a-f-]{36}$/i.test(id)) throw Error('workspace_mount_preflight_invalid');
  const volume = `uptokey-workspace-noswap-probe-${id}`;
  const container = `uptokey-workspace-noswap-probe-${id}`;
  if (operations.exists('volume', volume) || operations.exists('container', container)) throw Error('workspace_mount_preflight_collision');
  const args = ['volume', 'create', '--label', owner, '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=${WORKSPACE_VOLUME_OPTIONS}`, volume];
  const canary = 'const fs=require("node:fs"),p="/workspace/.uptokey-noswap-probe";fs.writeFileSync(p,"ok",{flag:"wx",mode:0o600});if(fs.readFileSync(p,"utf8")!=="ok")process.exit(31);fs.unlinkSync(p);process.stdout.write("UPTOKEY_NOSWAP_MOUNT_OK")';
  let failure = null, cleanupFailure = false;
  try {
    operations.run(args);
    assertWorkspaceVolume(JSON.parse(operations.run(['volume', 'inspect', volume]))[0], volume);
    const output = operations.run(['run', '--rm', '--pull=never', '--name', container, '--label', owner, '--network', 'none',
      '--user', '1000:1000', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--read-only',
      '--pids-limit=16', '--memory=128m', '--cpus=1', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=8m',
      '-v', `${volume}:/workspace:nocopy`, '--entrypoint', 'node', image, '-e', canary]);
    if (output !== 'UPTOKEY_NOSWAP_MOUNT_OK') throw Error('workspace_mount_preflight_canary_failed');
  } catch {
    failure = Error('workspace_mount_preflight_failed');
  } finally {
    try {
      if (operations.exists('container', container)) {
        const item = JSON.parse(operations.run(['inspect', container]))[0];
        if (item?.Name !== container || item.Config?.Labels?.['io.uptokey.experiment'] !== 'deepseek-workbench'
          || !/^[a-f0-9]{64}$/i.test(item.Id ?? '')) throw Error('workspace_mount_preflight_foreign_container');
        operations.run(['rm', '--force', item.Id]);
        if (operations.exists('container', container)) throw Error('workspace_mount_preflight_container_cleanup_failed');
      }
      if (operations.exists('volume', volume)) {
        assertWorkspaceVolume(JSON.parse(operations.run(['volume', 'inspect', volume]))[0], volume);
        operations.run(['volume', 'rm', volume]);
        if (operations.exists('volume', volume)) throw Error('workspace_mount_preflight_volume_cleanup_failed');
      }
    } catch {
      cleanupFailure = true;
    }
  }
  if (cleanupFailure) throw Error('workspace_mount_preflight_cleanup_failed');
  if (failure) throw failure;
  return true;
}

export function assertWorkspaceMount(container) {
  const mounts = container?.Mounts?.filter(item => item.Destination === '/workspace') ?? [];
  if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== WORKSPACE_VOLUME || mounts[0].RW !== true) {
    throw Error('workspace_mount_policy_invalid');
  }
  return mounts[0];
}

export function imageUsesEncryptedWorkspace(image, operations) {
  const value = JSON.parse(operations.run(['image', 'inspect', image]))[0];
  const labels = value?.Labels ?? value?.Config?.Labels ?? {};
  const policy = labels['io.uptokey.workspace'];
  if (policy === undefined) return false;
  if (policy !== WORKSPACE_POLICY) throw Error('workspace_image_policy_invalid');
  return true;
}

export function workspaceMountPreflightNeeded(policy, action, controller, executor) {
  if (!['start', 'refresh'].includes(action)) throw Error('workspace_mount_preflight_action_invalid');
  return policy && (action === 'refresh' || !controller?.State?.Running || !executor?.State?.Running);
}

export function ensureWorkspaceVolume(operations) {
  if (!operations.exists('volume', WORKSPACE_VOLUME)) {
    operations.run(['volume', 'create', '--label', owner, '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=${WORKSPACE_VOLUME_OPTIONS}`, WORKSPACE_VOLUME]);
  }
  return assertWorkspaceVolume(JSON.parse(operations.run(['volume', 'inspect', WORKSPACE_VOLUME]))[0]);
}
