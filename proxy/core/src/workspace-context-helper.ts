/** Bundled first-party native entry; the desktop grants no arbitrary CLI access. */
import { runWorkspaceContextCli } from './workspace-context-cli.ts';
await runWorkspaceContextCli(process.argv.slice(2));
