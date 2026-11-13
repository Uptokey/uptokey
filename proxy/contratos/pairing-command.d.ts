export function pairingApprovalCommand(
  challenge: { id: string; userCode: string },
  audience: "browser-extension" | "vscode",
  windows: boolean,
): string;
