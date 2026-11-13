const pairingId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pairingCode = /^[A-F0-9]{8}$/;
const audiences = new Set(["browser-extension", "vscode"]);

export function pairingApprovalCommand({ id, userCode }, audience, windows) {
  if (id.length !== 36 || !pairingId.test(id) || userCode.length !== 8 || !pairingCode.test(userCode) || !audiences.has(audience)) {
    throw new TypeError("invalid_pairing_command");
  }
  const executable = windows ? "npx.cmd" : "npx";
  return `${executable} --yes --prefer-offline uptokey@latest proxy pair approve ${id} ${userCode} --audience ${audience}`;
}
