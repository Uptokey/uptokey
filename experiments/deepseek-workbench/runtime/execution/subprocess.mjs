import SshSubprocessRuntime from '@deepseek-ai/dsh-subprocess-ssh';
import {materializationOwnership, observeProcessRange, observeTerminalRange} from '../extensions/materialization-ownership.mjs';

/** SSH execution provider with fail-closed ownership of every remote range. */
export default class WorkbenchSubprocessRuntime extends SshSubprocessRuntime {
  spawn(spec) {
    // Acquire before the synchronous spawn seam so an exclusive operation can
    // never pass between process admission and handle publication.
    const lease = materializationOwnership.acquire('process-range');
    let handle;
    try { handle = super.spawn(spec); }
    catch (error) { lease.release(); throw error; }
    observeProcessRange(lease, handle);
    return handle;
  }
  async spawnTerminal(spec) {
    // Claim before the first asynchronous allocation step. Otherwise an
    // exclusive sweep can enter while the remote terminal already has access
    // to materialized files but its handle has not been published yet.
    const lease = materializationOwnership.acquire('terminal-range');
    let handle;
    try { handle = await super.spawnTerminal(spec); }
    catch (error) { lease.release(); throw error; }
    observeTerminalRange(lease, handle);
    return handle;
  }
}
