/** Return later calls that repeat the same tool and argument prefix. */
export function detectRepeatedToolCalls(toolCalls: Array<{ id: string; name: string; args: string }>): Set<string> {
  const seen = new Map<string, string>();
  const repeated = new Set<string>();
  for (const call of toolCalls) {
    const key = `${call.name}:${call.args.slice(0, 200)}`;
    const previous = seen.get(key);
    if (previous !== undefined) repeated.add(call.id);
    else seen.set(key, call.id);
  }
  return repeated;
}
