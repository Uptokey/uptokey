import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** A fresh execution directory keeps earlier successes and failures intact. */
export function tuiEvidenceDirectory(core) {
  const directory = process.env.UPTOKEY_TUI_EVIDENCE_DIR
    ? resolve(process.env.UPTOKEY_TUI_EVIDENCE_DIR)
    : resolve(core,'../../output/tui-canonica',`${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}`);
  mkdirSync(directory,{recursive:true});
  return directory;
}
