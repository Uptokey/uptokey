/**
 * Uptokey TUI — Basic syntax highlighting for the terminal editor.
 * Provides token-level coloring for common languages.
 */

export interface Token {
  text: string;
  color: string;
  bold?: boolean;
  dimColor?: boolean;
}

type Language = "typescript" | "javascript" | "json" | "markdown" | "css" | "html" | "yaml" | "toml" | "unknown";

const KEYWORDS_TS = new Set([
  "const", "let", "var", "function", "class", "interface", "type", "enum",
  "import", "export", "from", "default", "return", "if", "else", "for",
  "while", "do", "switch", "case", "break", "continue", "try", "catch",
  "finally", "throw", "new", "delete", "typeof", "instanceof", "void",
  "async", "await", "yield", "extends", "implements", "static", "private",
  "protected", "public", "readonly", "abstract", "override", "declare",
  "as", "in", "of", "true", "false", "null", "undefined", "this", "super",
]);

const KEYWORDS_CSS = new Set([
  "color", "background", "border", "margin", "padding", "display", "position",
  "width", "height", "flex", "grid", "font", "text", "transform", "transition",
  "animation", "opacity", "overflow", "z-index", "box-shadow", "cursor",
]);

export function detectLanguage(path: string): Language {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, Language> = {
    ts: "typescript", tsx: "typescript", mts: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript",
    json: "json", jsonc: "json",
    md: "markdown", mdx: "markdown",
    css: "css", scss: "css",
    html: "html", htm: "html",
    yaml: "yaml", yml: "yaml",
    toml: "toml",
  };
  return langMap[ext] ?? "unknown";
}

export function tokenizeLine(line: string, lang: Language): Token[] {
  if (lang === "unknown") return [{ text: line, color: "white" }];

  const tokens: Token[] = [];
  let remaining = line;

  while (remaining.length > 0) {
    // Comments
    const commentMatch = remaining.match(/^(\/\/.*|#.*|\/\*.*?\*\/)/);
    if (commentMatch) {
      tokens.push({ text: commentMatch[0], color: "gray", dimColor: true });
      remaining = remaining.slice(commentMatch[0].length);
      continue;
    }

    // Strings
    const stringMatch = remaining.match(/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/);
    if (stringMatch) {
      tokens.push({ text: stringMatch[0], color: "green" });
      remaining = remaining.slice(stringMatch[0].length);
      continue;
    }

    // Numbers
    const numMatch = remaining.match(/^(\d+\.?\d*(?:e[+-]?\d+)?)/i);
    if (numMatch) {
      tokens.push({ text: numMatch[0], color: "yellow" });
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    // Keywords/identifiers
    const wordMatch = remaining.match(/^([a-zA-Z_$][\w$]*)/);
    if (wordMatch) {
      const word = wordMatch[0];
      const keywords = (lang === "typescript" || lang === "javascript") ? KEYWORDS_TS :
                       lang === "css" ? KEYWORDS_CSS : new Set<string>();
      if (keywords.has(word)) {
        tokens.push({ text: word, color: "magenta", bold: true });
      } else if (word[0] === word[0]?.toUpperCase() && /[a-z]/.test(word)) {
        tokens.push({ text: word, color: "cyan" }); // Type names
      } else {
        tokens.push({ text: word, color: "white" });
      }
      remaining = remaining.slice(word.length);
      continue;
    }

    // Operators
    const opMatch = remaining.match(/^([=!<>+\-*/%&|^~?:]+|[{}()\[\],;.])/);
    if (opMatch) {
      tokens.push({ text: opMatch[0], color: "yellow", dimColor: true });
      remaining = remaining.slice(opMatch[0].length);
      continue;
    }

    // Whitespace and other
    tokens.push({ text: remaining[0]!, color: "white" });
    remaining = remaining.slice(1);
  }

  return tokens;
}
