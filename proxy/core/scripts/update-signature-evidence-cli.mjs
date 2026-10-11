import { writeFileSync } from "node:fs";
import { createUpdateSignatureReceipt } from "./update-signature-evidence.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.subject || !args.signature || !args.publicKey || !args.out) throw new Error("uso: --subject <SHA256SUMS> --signature <sig> --publicKey <pem> --out <receipt.json>");
  const receipt = createUpdateSignatureReceipt(args.subject, args.signature, args.publicKey);
  writeFileSync(args.out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Assinatura de update verificada por ${receipt.signer.keyFingerprint}.\n`);
} catch {
  process.stderr.write("Evidência de update recusada: verification_failed\n");
  process.exitCode = 1;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) { const name = args[index]; const value = args[index + 1]; if (!name?.startsWith("--") || !value) throw new Error("update_evidence_arguments_invalid"); parsed[name.slice(2)] = value; }
  return parsed;
}
