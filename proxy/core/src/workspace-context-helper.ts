/** Bundled first-party native entry; the desktop grants no arbitrary CLI access. */
import { runWorkspaceContextCli } from './workspace-context-cli.ts';
import { BROWSER_PAIRING_OPERATIONS, runBrowserPairingOwner } from './browser-pairing-owner.ts';
import { NATIVE_PROVIDER_SETUP_OPERATION, runNativeProviderSetupOwner } from './native-provider-setup-owner.ts';

const args = process.argv.slice(2);
if (BROWSER_PAIRING_OPERATIONS.some(operation => operation === args[0])) await runBrowserPairingOwner(args);
else if (args[0] === NATIVE_PROVIDER_SETUP_OPERATION) await runNativeProviderSetupOwner(args);
else await runWorkspaceContextCli(args);
