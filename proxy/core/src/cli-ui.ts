export type CompletionShell = "bash" | "zsh" | "fish" | "powershell";

type CommandSpec = {
  name: string;
  summary: string;
  children?: readonly string[];
};

const COMMANDS: readonly CommandSpec[] = [
  { name: "version", summary: "mostra a versão do Uptokey" },
  { name: "doctor", summary: "verifica cofre, configuração e proxy local" },
  { name: "providers", summary: "lista provedores configurados e disponíveis" },
  { name: "models", summary: "lista modelos locais e configurados", children: ["install"] },
  { name: "proxy", summary: "inicia e administra o proxy local", children: ["start", "login", "pair", "control-pair"] },
  { name: "provider", summary: "configura, ativa e revoga provedores", children: ["add", "configure", "revoke"] },
  { name: "client", summary: "administra clientes locais pareados", children: ["create", "revoke"] },
  { name: "routing", summary: "define a ordem de fallback", children: ["set"] },
  { name: "integrations", summary: "inspeciona integrações compatíveis", children: ["list", "copy", "doctor"] },
  { name: "skills", summary: "instala e inspeciona pacotes de skills", children: ["install", "preview", "manifest", "uninstall"] },
  { name: "mcp", summary: "inicia o servidor MCP local" },
  { name: "tui", summary: "abre a interface de terminal" },
  { name: "update", summary: "verifica ou aplica atualizações", children: ["check", "apply"] },
  { name: "license", summary: "exibe a licença do core" },
  { name: "build-identity", summary: "exibe a identidade do build" },
  { name: "start", summary: "atalho compatível para proxy start" },
];

const TOP_LEVEL = COMMANDS.map((command) => command.name);

export function renderCliHelp(topic?: string): string {
  const normalized = topic?.trim().toLowerCase();
  const [rootName, childName] = normalized?.split(/\s+/) ?? [];
  const spec = rootName ? COMMANDS.find((item) => item.name === rootName) : undefined;
  const childKnown = !childName || Boolean(spec?.children?.includes(childName));
  if (normalized && (!spec || !childKnown)) {
    return `Comando desconhecido: ${topic}\n\n${renderCliHelp()}`;
  }
  if (spec) {
    const children = spec.children?.length ? `\nSubcomandos: ${spec.children.join(", ")}` : "";
    return [
      `Uso: uptokey ${spec.name}${childName ? ` ${childName}` : spec.children?.length ? " <subcomando>" : ""}`,
      `${spec.summary[0]!.toUpperCase() + spec.summary.slice(1)}${childName ? ` (${childName})` : ""}.`,
      children ? children.trimStart() : "",
      "\nUse `uptokey help` para a lista completa.",
    ].filter(Boolean).join("\n") + "\n";
  }
  return [
    "Uptokey",
    "",
    "Uso: uptokey <comando> [subcomando] [opções]",
    "     uptokey  — abre a interface interativa na pasta atual",
    "",
    ...COMMANDS.map(({ name, summary }) => `  ${name.padEnd(15)} ${summary}`),
    "",
    "Opções globais:",
    "  -h, --help       mostra esta ajuda ou a ajuda do comando",
    "  --version        mostra a versão do core",
    "",
    "Saída determinística:",
    "  version --json   identidade de build para scripts, sem segredos",
    "",
    "Exemplos:",
    "  uptokey",
    "  uptokey help proxy",
    "  uptokey doctor",
    "  uptokey completion powershell | Out-String | Invoke-Expression",
    "",
    "Chaves BYOK permanecem no cofre nativo; a CLI não as imprime.",
  ].join("\n") + "\n";
}

export function renderVersion(release: string, packageVersion: string, json = false): string {
  if (json) return JSON.stringify({ product: "uptokey", release, package: packageVersion, protocol: "openai-compatible-local" }) + "\n";
  return `${release}\n`;
}

/**
 * Legacy ANSI cover kept for consumers that explicitly render it.
 * The command entry now opens the TUI; help and pipes never call this function.
 */
export function renderCliCover(): string {
  const noColor = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
  const paint = (code: string, value: string): string => noColor ? value : `\u001b[${code}m${value}\u001b[0m`;
  const blue = (value: string) => paint("38;2;1;122;255", value);
  const neon = (value: string) => paint("38;2;108;71;255", value);
  const muted = (value: string) => paint("38;2;71;85;105", value);
  const hairline = (value: string) => paint("38;2;226;232;240", value);
  return [
    "",
    `             ${blue("╭──╮")}    ${neon("╭─╮")}`,
    `           ${blue("╭─╯  ╰─╮")} ${neon("╭─╯ ╰─╮")}`,
    `           ${blue("╰─╮  ╭─╯")} ${neon("╰─────╯")}`,
    `             ${blue("╰──╯")}      `,
    `                  ${paint("1;38;2;15;23;42", "UPTOKEY")}`,
    `                ${muted("proxy local")}`,
    `              ${hairline("──────────────────")}`,
    `           ${muted("Sovereign Glass & Paper")}`,
    "",
    `              ${blue("light")}  ${neon("CLI ready")}`,
    `              ${muted("help: uptokey help")}`,
    "",
  ].join("\n");
}

export function completionScript(shell: CompletionShell): string {
  const commands = TOP_LEVEL.join(" ");
  switch (shell) {
    case "bash":
      return `_uptokey_complete() {\n  local cur="${"$"}{COMP_WORDS[COMP_CWORD]}"\n  COMPREPLY=($(compgen -W "${commands} help completion" -- "${"$"}cur"))\n}\ncomplete -F _uptokey_complete uptokey\n`;
    case "zsh":
      return `#compdef uptokey\n_arguments '1:command:(help completion ${commands})'\n`;
    case "fish":
      return `complete -c uptokey -f -n '__fish_use_subcommand' -a '${commands} help completion'\n`;
    case "powershell":
      return `Register-ArgumentCompleter -Native -CommandName uptokey -ScriptBlock { param($wordToComplete)\n  '${commands} help completion' -split ' ' | Where-Object { $_ -like \"$wordToComplete*\" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }\n}\n`;
  }
}

export function isCompletionShell(value: string | undefined): value is CompletionShell {
  return value === "bash" || value === "zsh" || value === "fish" || value === "powershell";
}
