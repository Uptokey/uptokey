import { writeFileSync } from "node:fs";
import { createMacosDistributionReceipt, createNativeReceipt } from "./native-signature-evidence.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.platform || !args.artifact || !args.out) throw new Error("uso: --platform <windows|macos|linux> --artifact <path> --out <receipt.json> [--signature <sig> --keyring <gpg-keyring>]");
  const receipt = args.platform === "macos" && args.macosArchive === "true"
    ? await createMacosDistributionReceipt(args.artifact)
    : createNativeReceipt(args.platform, args.artifact, args);
  writeFileSync(args.out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Recibo nativo ${args.platform} criado para ${receipt.subjectSha256}.\n`);
} catch {
  process.stderr.write("Recibo nativo recusado: verification_failed\n");
  process.exitCode = 1;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]; const value = args[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("native_evidence_arguments_invalid");
    parsed[name.slice(2)] = value;
  }
  return parsed;
}
