import { runMacosUpdateHelper } from "./macos-update-helper.mjs";

try {
  await runMacosUpdateHelper({
    journalPath: process.argv[2],
    stagedArchive: process.argv[3],
    installedApp: process.argv[4],
    oldPid: Number(process.argv[5]),
  });
} catch (error) {
  process.stderr.write("Helper macOS recusado: update_failed\n");
  process.exitCode = 1;
}
