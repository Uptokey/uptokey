/**
 * Uptokey TUI — Theme system.
 *
 * Paleta oficial Uptokey (hex → ANSI 256 mais próximo para terminais):
 *
 *   Dodger Blue   #017AFF  → ansi256 #0087ff  (27)   → "blue" / "#0087ff"
 *   Neon          #6C47FF  → ansi256 #5f5fff  (63)   → "#5f5fff"
 *   Turquoise     #39C0C8  → ansi256 #00afaf  (37)   → "cyan" / "#00afaf"
 *   Safety Orange #F96300  → ansi256 #ff6600  (208)  → "#ff6600"
 *   Wild Melon    #F34971  → ansi256 #ff005f  (197)  → "#ff005f"
 *   Coral         #FF9382  → ansi256 #ff875f  (209)  → "#ff875f"
 *   Amber         #F5C900  → ansi256 #ffcc00  (220)  → "yellow" / "#ffcc00"
 *   Tan           #CDAD7A  → ansi256 #af8787  (138)  → "#af8787"
 *   Celery        #AABB5D  → ansi256 #afd75f  (149)  → "green" / "#afd75f"
 *
 * Tipografia (para referência de documentação/web apenas — terminal não aplica fonte):
 *   Títulos: Nunito
 *   Texto:   IBM Plex Sans / IBM Plex Mono (código)
 */

export interface Theme {
  name: string;
  /** Paleta hex canônica Uptokey (para uso em WebUI/relatórios gerados pelo TUI). */
  palette: UptoKeyPalette;
  colors: ThemeColors;
}

/** Paleta hex oficial — use em artefatos HTML/SVG gerados pelo TUI. */
export interface UptoKeyPalette {
  dodgerBlue: string;
  neon: string;
  turquoise: string;
  safetyOrange: string;
  wildMelon: string;
  coral: string;
  amber: string;
  tan: string;
  celery: string;
}

export const UPTOKEY_PALETTE: UptoKeyPalette = {
  dodgerBlue:   "#017AFF",
  neon:         "#6C47FF",
  turquoise:    "#39C0C8",
  safetyOrange: "#F96300",
  wildMelon:    "#F34971",
  coral:        "#FF9382",
  amber:        "#F5C900",
  tan:          "#CDAD7A",
  celery:       "#AABB5D",
};

export interface ThemeColors {
  // ── Marca ───────────────────────────────────────────────────────────────────
  /** Azul primário Uptokey (Dodger Blue). */
  brand: string;
  /** Roxo secundário (Neon). */
  brandAlt: string;
  /** Turquesa — accent interativo. */
  accent: string;

  // ── Chrome ──────────────────────────────────────────────────────────────────
  statusBg: string;
  statusFg: string;
  statusAccent: string;

  // ── Chat ────────────────────────────────────────────────────────────────────
  userMessage: string;
  assistantMessage: string;
  systemMessage: string;
  streamCursor: string;
  errorText: string;
  warningText: string;
  /** Cor para custo/tokens — Amber Uptokey. */
  costText: string;
  /** Cor para tool calls em execução — Neon Uptokey. */
  toolRunning: string;
  /** Cor para tool calls concluídos — Celery Uptokey. */
  toolDone: string;
  /** Cor para tool calls com erro — Safety Orange. */
  toolError: string;

  // ── Editor ──────────────────────────────────────────────────────────────────
  lineNumber: string;
  lineNumberActive: string;
  cursorLine: string;
  selection: string;
  modeNormal: string;
  modeInsert: string;
  modeSelect: string;

  // ── UI ──────────────────────────────────────────────────────────────────────
  border: string;
  borderActive: string;
  menuItem: string;
  menuItemSelected: string;
  menuItemDescription: string;
  scrollbar: string;
  /** Texto muted/dimColor. */
  muted: string;

  // ── Sintaxe ─────────────────────────────────────────────────────────────────
  keyword: string;
  string: string;
  number: string;
  comment: string;
  type: string;
  operator: string;
  function: string;

  // ── Diff ────────────────────────────────────────────────────────────────────
  diffAdd: string;
  diffRemove: string;
  diffContext: string;
  diffHunkHeader: string;

  // ── Git ─────────────────────────────────────────────────────────────────────
  gitStaged: string;
  gitUnstaged: string;
  gitUntracked: string;
  gitBranch: string;

  // ── Risco (Jev guard badges) ─────────────────────────────────────────────────
  riskHigh: string;
  riskMedium: string;
  riskLow: string;
}

/**
 * Tema escuro — identidade Uptokey.
 * ANSI nomeados onde o terminal suporta; hex ANSI-256 onde mais preciso.
 * Ink/chalk convertem hex para o ANSI-256 mais próximo automaticamente.
 */
export const DARK_THEME: Theme = {
  name: "dark",
  palette: UPTOKEY_PALETTE,
  colors: {
    // Marca
    brand:            "#017AFF",   // Dodger Blue
    brandAlt:         "#6C47FF",   // Neon
    accent:           "#39C0C8",   // Turquoise

    // Chrome
    statusBg:         "black",
    statusFg:         "white",
    statusAccent:     "#017AFF",   // Dodger Blue

    // Chat
    userMessage:      "white",
    assistantMessage: "#39C0C8",   // Turquoise — resposta do modelo
    systemMessage:    "#F5C900",   // Amber — mensagens de sistema/contexto
    streamCursor:     "#017AFF",   // Dodger Blue — cursor de streaming
    errorText:        "#F96300",   // Safety Orange — erros
    warningText:      "#F5C900",   // Amber — avisos
    costText:         "#F5C900",   // Amber — custo/tokens
    toolRunning:      "#6C47FF",   // Neon — ferramenta em andamento
    toolDone:         "#AABB5D",   // Celery — ferramenta concluída
    toolError:        "#F96300",   // Safety Orange — ferramenta com erro

    // Editor
    lineNumber:       "gray",
    lineNumberActive: "#F5C900",   // Amber
    cursorLine:       "#017AFF",   // Dodger Blue
    selection:        "#6C47FF",   // Neon
    modeNormal:       "#017AFF",   // Dodger Blue — modo normal Helix
    modeInsert:       "#AABB5D",   // Celery — modo inserção
    modeSelect:       "#6C47FF",   // Neon — modo seleção

    // UI
    border:           "gray",
    borderActive:     "#39C0C8",   // Turquoise — borda do elemento focado
    menuItem:         "white",
    menuItemSelected: "#39C0C8",   // Turquoise — item selecionado
    menuItemDescription: "gray",
    scrollbar:        "#6C47FF",   // Neon — scrollbar animada
    muted:            "gray",

    // Sintaxe — mantém legibilidade padrão, toca nas cores de marca
    keyword:          "#6C47FF",   // Neon — keywords
    string:           "#AABB5D",   // Celery — strings
    number:           "#F5C900",   // Amber — números
    comment:          "gray",
    type:             "#39C0C8",   // Turquoise — tipos
    operator:         "#FF9382",   // Coral — operadores
    function:         "#017AFF",   // Dodger Blue — funções

    // Diff
    diffAdd:          "#AABB5D",   // Celery
    diffRemove:       "#F34971",   // Wild Melon
    diffContext:      "white",
    diffHunkHeader:   "#39C0C8",   // Turquoise

    // Git
    gitStaged:        "#AABB5D",   // Celery
    gitUnstaged:      "#F5C900",   // Amber
    gitUntracked:     "gray",
    gitBranch:        "#39C0C8",   // Turquoise

    // Risco
    riskHigh:         "#F34971",   // Wild Melon
    riskMedium:       "#F5C900",   // Amber
    riskLow:          "#AABB5D",   // Celery
  },
};

/**
 * Tema claro — identidade Uptokey em fundo branco.
 * Satura ligeiramente as cores para manter contraste.
 */
export const LIGHT_THEME: Theme = {
  name: "light",
  palette: UPTOKEY_PALETTE,
  colors: {
    ...DARK_THEME.colors,
    statusBg:         "white",
    statusFg:         "black",
    statusAccent:     "#017AFF",
    userMessage:      "black",
    assistantMessage: "#017AFF",   // Dodger Blue — mais legível em claro
    systemMessage:    "#F96300",   // Safety Orange
    streamCursor:     "#017AFF",
    lineNumber:       "gray",
    lineNumberActive: "#017AFF",
    menuItem:         "black",
    border:           "gray",
    borderActive:     "#017AFF",
    menuItemSelected: "#017AFF",
    diffContext:      "black",
    muted:            "gray",
  },
};

export function getTheme(name?: string): Theme {
  if (name === "light") return LIGHT_THEME;
  return DARK_THEME;
}

/**
 * Retorna a paleta hex canônica para uso em artefatos HTML/SVG/relatórios
 * gerados pelo TUI (não aplica ao terminal em si).
 */
export function getBrandPalette(): UptoKeyPalette {
  return UPTOKEY_PALETTE;
}
