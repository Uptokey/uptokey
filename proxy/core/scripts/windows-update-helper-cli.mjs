import { runWindowsUpdateHelper } from "./windows-update-helper.mjs";

try {
  await runWindowsUpdateHelper({
    journalPath: process.argv[2],
    stagedExecutable: process.argv[3],
    installedExecutable: process.argv[4],
    oldPid: Number(process.argv[5]),
  });
} catch (error) {
  process.stderr.write("Helper Windows recusado: update_failed\n");
  process.exitCode = 1;
}
