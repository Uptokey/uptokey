const TRUNCATED_LINE_SUFFIX = /^(.*)\.\.\. \(line truncated to (\d+) chars\)$/su;

export function logicalLines(text) {
  if (typeof text !== 'string') return undefined;
  const lines = text.split('\n');
  // tool-fs does not manufacture a final empty line solely for a terminal LF.
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
}

export function mutationValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { path, after } = value;
  return typeof path === 'string' && path.length > 0 && typeof after === 'string'
    ? { path, after }
    : undefined;
}

function readValue(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { path, offset, lines, totalLines } = value;
  if (typeof path !== 'string' || path.length === 0 || offset !== 1
    || !Number.isInteger(totalLines) || totalLines < 0 || !Array.isArray(lines)) return undefined;
  const parsed = [];
  for (const line of lines) {
    if (typeof line !== 'object' || line === null || Array.isArray(line)
      || !Number.isInteger(line.number) || line.number < 1 || typeof line.text !== 'string') return undefined;
    parsed.push({ number: line.number, text: line.text });
  }
  return { path, lines: parsed, totalLines };
}

/**
 * Compare a canonical mutation result with the bounded structured value from
 * tool-fs/read. `bounded` means the actual reread happened but its model-facing
 * window could not prove every byte; it is deliberately distinct from a real
 * mismatch.
 */
export function classifyReadback(path, after, candidate) {
  const expected = logicalLines(after);
  const read = readValue(candidate);
  if (expected === undefined || read === undefined) return 'unavailable';
  if (read.path !== path) return 'mismatch';
  if (read.totalLines !== expected.length) return 'mismatch';
  if (read.lines.length < read.totalLines) return 'bounded';
  if (read.lines.length !== read.totalLines) return 'unavailable';

  let bounded = false;
  for (let index = 0; index < read.lines.length; index += 1) {
    const actual = read.lines[index];
    if (actual.number !== index + 1) return 'unavailable';
    if (actual.text === expected[index]) continue;
    const truncated = TRUNCATED_LINE_SUFFIX.exec(actual.text);
    if (truncated === null) return 'mismatch';
    const limit = Number(truncated[2]);
    if (!Number.isInteger(limit) || limit < 0 || truncated[1].length !== limit
      || !expected[index].startsWith(truncated[1])) return 'mismatch';
    bounded = true;
  }
  return bounded ? 'bounded' : 'exact';
}

const NOTICE_TEXT = Object.freeze({
  exact: 'Uptokey reread the saved file after this mutation and verified that its complete text matches the committed result. Base any completion claim on this reread.',
  bounded: 'Uptokey reread the saved file after this mutation. The file-tool output limit prevented a complete text comparison; read the remaining ranges before claiming a complete match.',
  mismatch: 'Uptokey reread the saved file after this mutation and found that its current text differs from the committed result. Inspect the file before reporting completion.',
  unavailable: 'Uptokey could not complete the required reread after this mutation. The mutation remains committed, but do not report it as verified until the file is inspected.',
});

function notice(createUserMessage, status) {
  return createUserMessage({
    content: [{ type: 'text', text: NOTICE_TEXT[status] }],
    source: {
      kind: 'uptokey-post-edit-verification',
      form: 'notice',
      summary: status === 'exact' ? 'Saved file reread and verified' : `Saved file reread: ${status}`,
    },
  });
}

function appendContexts(decision, contexts) {
  if (contexts.length === 0) return decision;
  return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], ...contexts] };
}

export function createPostEditVerificationHandler(tools, createUserMessage) {
  if (typeof tools?.execute !== 'function') throw new TypeError('tools.execute is required');
  if (typeof createUserMessage !== 'function') throw new TypeError('createUserMessage is required');

  return async function postEditVerification(exec, result, next) {
    const decision = await next();
    if (decision.kind === 'block' || result.isError || (exec.name !== 'edit' && exec.name !== 'write')) return decision;
    const mutation = mutationValue(result.value);
    if (mutation === undefined) return decision;

    let status = 'unavailable';
    let nestedContexts = [];
    try {
      const readback = await tools.execute({
        callId: `${String(exec.callId)}:uptokey-reread`,
        rootCallId: exec.rootCallId,
        name: 'read',
        arguments: { file_path: mutation.path },
        ...exec.agent === undefined ? {} : { agent: exec.agent },
        parent: exec.token,
        signal: exec.signal,
      });
      nestedContexts = readback.additionalContexts ?? [];
      if (!readback.isError) status = classifyReadback(mutation.path, mutation.after, readback.value);
    } catch {
      // A failed verification must not rewrite the already committed mutation.
      status = 'unavailable';
    }
    return appendContexts(decision, [...nestedContexts, notice(createUserMessage, status)]);
  };
}
