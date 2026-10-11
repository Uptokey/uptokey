import { parseMessage, parseMessagePart, type MessagePart } from "@uptokey/sync-contract/conversation";
import type { ThreadMessage } from "./conversations.ts";
import { t } from "./i18n.ts";

export type ChatFileReference =
  | { kind: "project-file"; projectId: string; rootBindingId: string; path: string; sha256: string; byteLength: number; messageId: string }
  | { kind: "artifact"; projectId: string; artifactId: string; filename: string; mediaType: string; sha256: string; byteLength: number; messageId: string };

function fenced(value: unknown, language = ""): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const fence = "`".repeat(Math.max(3, ...[...(text ?? "").matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}${language}\n${text ?? ""}\n${fence}\n\n`;
}

/** Preserve canonical parts; export never reconstructs tool evidence. */
export function formatConversationAsMarkdown(title: string | undefined, messages: readonly Pick<ThreadMessage, "role" | "parts">[]): string {
  let md = `# ${(title || t("export_title")).replace(/[\r\n]+/g, " ")}\n\n`;
  for (const message of messages) {
    md += `## ${t(message.role === "user" ? "export_user" : message.role === "assistant" ? "export_assistant" : "export_tool")}\n\n`;
    for (const part of message.parts) {
      if (part.type === "text") md += `${part.text ?? ""}\n\n`;
      else if (part.type === "tool_call" || part.type === "tool_result") {
        md += `### ${t(part.type === "tool_call" ? "export_tool_call" : "export_tool_result")}\n\n${fenced(part.text, "json")}`;
      } else {
        md += `### ${part.type}\n\n${fenced({ ...(part.name ? { name: part.name } : {}), ...(part.artifactRef ? { artifactRef: part.artifactRef } : {}), ...(part.text !== undefined ? { text: part.text } : {}) }, "json")}`;
      }
    }
    md += "---\n\n";
  }
  return md;
}

/** The HTTP export returns an envelope, never a bare message array. */
export function markdownFromCanonicalExport(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("conversation_export_invalid");
  const data = input as { schemaVersion?: unknown; conversation?: { title?: unknown }; messages?: unknown };
  if (data.schemaVersion !== 1 || !data.conversation || typeof data.conversation.title !== "string" || !Array.isArray(data.messages)) throw new Error("conversation_export_invalid");
  const messages = data.messages.map(raw => {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.parts)) throw new Error("conversation_export_invalid");
    const { parts, ...meta } = raw;
    const message = parseMessage(meta);
    return { ...message, parts: parts.map(parseMessagePart) };
  });
  return formatConversationAsMarkdown(data.conversation.title, messages);
}

/** References come from typed stored parts, not filenames guessed from model prose. */
export function projectFileReference(projectId: string, messageId: string, part: MessagePart): ChatFileReference | null {
  if (part.type !== "file" || typeof part.text !== "string") return null;
  try {
    const ref = JSON.parse(part.text)?.tuiContext;
    if (ref?.v !== 1 || typeof ref.rootBindingId !== "string" || typeof ref.relativePath !== "string" || typeof ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) return null;
    const path = ref.relativePath.replaceAll("\\", "/");
    if (!path || path.includes(":") || path.startsWith("/") || path.split("/").some((segment: string) => !segment || segment === "." || segment === "..") || /[\x00-\x1f]/.test(path)) return null;
    return { kind: "project-file", projectId, messageId, rootBindingId: ref.rootBindingId, path, sha256: ref.sha256, byteLength: ref.byteLength };
  } catch { return null; }
}
