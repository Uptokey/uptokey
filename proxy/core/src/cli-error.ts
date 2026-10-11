export const CLI_FAILURE_CODE = "uptokey_command_failed";

const CONTROLLED_MESSAGE = /^uptokey_[a-z0-9_]+(?::|$)/i;

/**
 * Last-resort CLI boundary. Residual failures are deliberately opaque
 * (test contract: test/cli-error.test.ts) — native messages, paths and
 * secrets never reach the user. Expected command errors are handled closer
 * to their source and carry a controlled `uptokey_*` message that is safe
 * to show verbatim.
 */
export function publicCliFailure(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  if (CONTROLLED_MESSAGE.test(message)) return message.split("\n")[0] ?? CLI_FAILURE_CODE;
  return CLI_FAILURE_CODE;
}
