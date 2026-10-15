import { t } from "./i18n.ts";
import { chromeText } from "./ui-chrome.ts";
import { accountText } from "./account-ui.ts";
import { hostedText } from "./hosted-ui.ts";
/**
 * Uptokey TUI — single command registry.
 *
 * Palette, slash commands, key bindings and help all come from this list, so
 * every exposed action has one id, one description and one executor. A
 * command that cannot run explains why instead of pretending to work.
 */
import type { TuiController } from "./controller.ts";

export type PanelName =
  | "review" | "context" | "sessions" | "models" | "files" | "editor" | "git" | "search" | "usage" | "doctor"
  | "help" | "projects" | "agents" | "approvals" | "attention" | "branches" | "versions" | "connections" | "hooks" | "skills" | "artifacts"
  | "capabilities" | "comparison" | "debugger" | "voice" | "file-actions" | "jev" | "account";

export interface UiActions {
  openPanel(name: PanelName, arg?: string): void;
  closePanel(): void;
  setDraft(text: string): void;
  exit(): void;
  startService(): Promise<void>;
  toggleExpanded(): void;
  setLinear(on: boolean): void;
  setTheme(name: string): void;
  copyTranscript(scope: "response" | "conversation"): Promise<void>;
  beginTranscriptSelection?(): void;
  showChatFiles?(messageId?: string): void;
  copyCodeBlock?(): Promise<void>;
}

export interface CommandContext {
  controller: TuiController;
  ui: UiActions;
}

export interface CommandSpec {
  id: string;
  title: string;
  group: "Conversa" | "Contexto" | "Código" | "Projeto" | "Modelos" | "Interface" | "Diagnóstico";
  /** Slash aliases without the leading slash (first is canonical). */
  slash: string[];
  /** Human key hint shown in help/palette (routing lives in the App key map). */
  keys?: string;
  /** Argument description when the command takes one. */
  arg?: string;
  /** Returns a reason string when unavailable. */
  unavailable?: (ctx: CommandContext) => string | null;
  run: (ctx: CommandContext, arg: string) => void | Promise<void>;
}

const needsProject = ({ controller }: CommandContext) => controller.view.binding ? null : t("error_needs_project_sem_pasta_vincu");
const needsConversation = ({ controller }: CommandContext) => controller.state.activeConversation ? null : t("error_needs_conversation_nenhuma_co");

import { parseArgs } from "node:util";

export function parseFlags(input: string, flagNames: string[]): { args: string[]; hasFlag: (f: string) => boolean; error?: string } {
  const flags = new Set<string>();
  const inTokens: string[] = [];
  let inQuotes: string | null = null;
  let currentToken = "";
  
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (inQuotes) {
      if (char === inQuotes) {
        inQuotes = null;
      } else {
        currentToken += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inQuotes = char;
      continue;
    }
    if (/^\s$/.test(char)) {
      if (currentToken.length > 0) {
        inTokens.push(currentToken);
        currentToken = "";
      }
      continue;
    }
    currentToken += char;
  }
  if (currentToken.length > 0) {
    inTokens.push(currentToken);
  }
  
  if (inQuotes !== null) {
    return { args: [], hasFlag: () => false, error: t("error_syntax_unclosed_quotes") };
  }
  
  let parsingFlags = true;
  const outArgs: string[] = [];
  
  for (const token of inTokens) {
    if (parsingFlags && token === "--") {
      parsingFlags = false;
      continue;
    }
    if (parsingFlags && token.startsWith("--")) {
      const flagStr = token.slice(2);
      if (flagStr.includes("=")) {
        return { args: [], hasFlag: () => false, error: t("error_boolean_flag_equals") };
      }
      if (flagNames.includes(flagStr)) {
        flags.add(flagStr);
        continue;
      } else {
        return { args: [], hasFlag: () => false, error: t("error_unknown_flag", { flag: token }) };
      }
    }
    outArgs.push(token);
  }
  
  return { args: outArgs, hasFlag: (f: string) => flags.has(f) };
}

export const COMMANDS: CommandSpec[] = [
  { id: "hosted.receipt", get title() { return hostedText("receipt"); }, group: "Conversa", slash: ["receipt", "recibo"], arg: "[id]", run: ({ controller }, arg) => controller.checkHostedReceipt(arg) },
  { id: "account.show", get title() { return accountText("title"); }, group: "Interface", slash: ["account", "conta", "cuenta", "compte", "konto", "アカウント", "계정", "账户", "حساب"], run: ({ ui, controller }) => { void controller.account.refresh(); ui.openPanel("account"); } },
  { id: "chat.select", get title() { return t("selection_title"); }, group: "Conversa", slash: ["select-text", "selecionar"], run: ({ ui }) => ui.beginTranscriptSelection?.() },
  { id: "chat.files", get title() { return t("file_actions_title"); }, group: "Conversa", slash: ["chat-files", "arquivos-chat"], run: ({ ui }) => ui.showChatFiles?.() },
  { id: "chat.copy", get title() { return t("copy_title"); }, group: "Conversa", slash: ["copy", "copiar"], get arg() { return "[conversation|code]"; }, run: ({ controller, ui }, arg) => {
    const target = arg.trim().toLowerCase();
    if (target === "codigo" || target === "code" || target === "código") return ui.copyCodeBlock?.();
    if (target && !["resposta", "response", "conversa", "conversation"].includes(target)) { controller.notice("info", t("copy_usage")); return; }
    return ui.copyTranscript(target === "conversa" || target === "conversation" ? "conversation" : "response");
  } },
  { id: "lsp.actions", get title() { return t("command_lsp_actions"); }, group: "Código", slash: ["code-actions", "acoes-codigo"], get arg() { return chromeText("arg_position"); }, unavailable: needsProject, run: ({controller},arg) => controller.lspCodeActions(arg) },
  { id: "features.menu", get title() { return t("command_features_menu"); }, group: "Projeto", slash: ["features", "recursos"], run: ({ui}) => ui.openPanel("capabilities") },
  { id: "features.image", get title() { return t("command_features_image"); }, group: "Projeto", slash: ["image", "imagem"], get arg() { return chromeText("arg_description"); }, unavailable: needsProject, run: ({controller},text) => text.trim()?controller.features.media("image",text):controller.notice("info",t('uso_imagem_descreva_o_resultad')) },
  { id: "features.video", get title() { return t("command_features_video"); }, group: "Projeto", slash: ["video"], get arg() { return chromeText("arg_description"); }, unavailable: needsProject, run: ({controller},text) => text.trim()?controller.features.media("video",text):controller.notice("info",t('uso_video_descreva_o_resultado')) },
  { id: "features.speech", get title() { return t("command_features_speech"); }, group: "Projeto", slash: ["speak", "falar"], get arg() { return chromeText("arg_text"); }, unavailable: needsProject, run: ({controller},text) => text.trim()?controller.features.media("speech",text):controller.notice("info",t('uso_falar_texto_para_sintetiza')) },
  { id: "features.microphone", get title() { return t("command_features_microphone"); }, group: "Conversa", slash: ["mic", "microfone", "ditar"], unavailable: needsProject, run: ({controller}) => controller.features.microphone() },
  { id: "features.voice.setup", get title() { return t("command_features_voice_setup"); }, group: "Conversa", slash: ["voice-setup", "voz-config"], get arg() { return chromeText("arg_model"); }, run: ({controller},arg) => controller.features.voiceSetup(arg) },
  { id: "features.voice", get title() { return t("command_features_voice"); }, group: "Conversa", slash: ["voice", "voz"], unavailable: needsProject, run: ({controller}) => controller.features.startVoice() },
  { id: "features.comparisons", get title() { return t("command_features_comparisons"); }, group: "Modelos", slash: ["comparisons", "comparacoes"], get arg() { return "[id] [cancelar]"; }, unavailable: needsProject, run: ({controller},arg) => {const [id,action]=arg.trim().split(/\s+/);return controller.features.comparisons(id||undefined,action==='cancelar');} },
  { id: "features.transcription.setup", get title() { return t("command_features_transcription_setup"); }, group: "Projeto", slash: ["transcription", "transcricao"], get arg() { return chromeText("arg_model_endpoint"); }, run: ({controller},arg) => controller.features.transcriptionSetup(arg) },
  { id: "features.transcribe", get title() { return t("command_features_transcribe"); }, group: "Projeto", slash: ["transcribe", "transcrever"], get arg() { return chromeText("arg_file"); }, unavailable: needsProject, run: ({controller},path) => path.trim()?controller.features.transcribe(path.trim()):controller.notice("info",t('uso_transcrever_caminho_do_aud')) },
  { id: "features.rag", get title() { return t("command_features_rag"); }, group: "Contexto", slash: ["rag"], get arg() { return chromeText("arg_question"); }, unavailable: needsProject, run: ({controller},query) => query.trim()?controller.features.rag(query):controller.notice("info",t('uso_rag_pergunta_sobre_os_arqu')) },
  { id: "features.mcp", get title() { return t("command_features_mcp"); }, group: "Projeto", slash: ["mcp"], get arg() { return `listar|ler ${chromeText("arg_path")}`; }, unavailable: needsProject, run: ({controller},arg) => {
    if(!arg.trim()||arg.trim()==='ferramentas')return controller.features.mcpList();
    const match=/^(listar|ler)\s+(.+)$/s.exec(arg.trim());
    return match?controller.features.mcp(match[1]==="ler"?"read_text_file":"list_directory",match[2]!):controller.notice("info",t('uso_mcp_listar_ou_mcp_ler_cami'));
  } },
  { id: "features.browser", get title() { return t("command_features_browser"); }, group: "Projeto", slash: ["browse", "navegar"], get arg() { return "URL"; }, unavailable: needsProject, run: ({controller},arg) => arg.trim()?controller.features.browser(arg.trim()):controller.notice('info',t('uso_navegar_url_da_origem_conf')) },
  { id: "features.browser-fill", get title() { return t("command_features_browser-fill"); }, group: "Projeto", slash: ["fill", "preencher"], get arg() { return chromeText("arg_fill"); }, unavailable: needsProject, run: ({controller},arg) => {const split=arg.indexOf(' ');try{if(split<1)throw Error();const fields:unknown=JSON.parse(arg.slice(split+1));if(!Array.isArray(fields)||!fields.every(field=>field&&typeof field.label==='string'&&typeof field.value==='string'))throw Error();return controller.features.browser(arg.slice(0,split),fields);}catch{controller.notice('info',chromeText("browser_fill_usage"));}} },
  { id: "features.compare", get title() { return t("command_features_compare"); }, group: "Modelos", slash: ["compare", "comparar"], get arg() { return chromeText("arg_objective"); }, unavailable: needsProject, run: ({ui},arg) => ui.openPanel("comparison",arg) },
  { id: "features.delegate-models", get title() { return t("command_features_delegate-models"); }, group: "Modelos", slash: ["delegate-models", "delegar-modelos"], get arg() { return chromeText("arg_objective"); }, unavailable: needsProject, run: ({ui},arg) => ui.openPanel("comparison",`delegate:${arg}`) },
  { id: "debug.start", get title() { return t("command_debug_start"); }, group: "Código", slash: ["debug", "depurar"], get arg() { return chromeText("arg_file"); }, unavailable: needsProject, run: ({controller,ui},arg) => arg.trim()?controller.features.startDebugger(arg.trim()):ui.openPanel("debugger") },
  { id: "chat.new", get title() { return t("command_chat_new"); }, group: "Conversa", slash: ["new", "novo"], keys: "Ctrl+N", run: ({ controller, ui }) => { controller.newConversation(); ui.closePanel(); } },
  { id: "chat.sessions", get title() { return t("command_chat_sessions"); }, group: "Conversa", slash: ["sessions", "sessoes", "retomar"], keys: "Ctrl+S", run: ({ ui, controller }) => { void controller.refreshConversationList(); ui.openPanel("sessions"); } },
  { id: "chat.search", get title() { return t("command_chat_search"); }, group: "Conversa", slash: ["search", "buscar"], run: ({ ui }) => ui.openPanel("search") },
  { id: "chat.fork", get title() { return t("command_chat_fork"); }, group: "Conversa", slash: ["fork", "ramificar"], unavailable: needsConversation, run: ({ controller }) => controller.fork() },
  { id: "chat.undo", get title() { return t("command_chat_undo"); }, group: "Conversa", slash: ["undo", "desfazer"], unavailable: needsConversation, run: ({ controller }) => {
    if (controller.view.proposal) {
      controller.rejectProposal();
    } else {
      controller.notice("info", t('desfazer_info'));
    }
  } },
  { id: "chat.branches", get title() { return t("command_chat_branches"); }, group: "Conversa", slash: ["branches", "ramos"], unavailable: needsConversation, run: ({ ui }) => ui.openPanel("branches") },
  { id: "chat.compact", get title() { return t("command_chat_compact"); }, group: "Conversa", slash: ["compact", "compactar"], unavailable: needsConversation, run: ({ controller }) => controller.compact() },
  { id: "chat.correct", get title() { return t("command_chat_correct"); }, group: "Código", slash: ["fix", "corrigir"], keys: "Ctrl+F", unavailable: ({ controller }) => controller.view.correction ? null : t("error_chat_correct_nenhuma_falha_pa"), run: ({ controller }) => controller.requestCorrection() },
  { id: "chat.close-tools", get title() { return t("command_chat_close-tools"); }, group: "Conversa", slash: ["close-tools", "fechar-ferramentas"], unavailable: needsConversation, run: ({ controller }) => controller.closePendingToolCalls() },
  { id: "chat.processing", get title() { return t("command_chat_processing"); }, group: "Conversa", slash: ["processing", "processamento"], get arg() { return "local|external"; }, run: ({ controller }, arg) => {
    const value = arg.trim().toLowerCase();
    if (value.startsWith("ext")) return controller.setProcessingPolicy("external_allowed");
    if (value.startsWith("loc")) return controller.setProcessingPolicy("local_only");
    controller.notice("info", chromeText("processing_status", { policy: chromeText(controller.state.processingPolicy === "external_allowed" ? "processing_external" : "processing_local") }));
  } },
  { id: "chat.delete", get title() { return t("command_chat_delete"); }, group: "Conversa", slash: ["delete", "apagar"], unavailable: needsConversation, run: ({ ui }) => ui.openPanel("sessions") },
  { id: "chat.export", get title() { return t("command_chat_export"); }, group: "Conversa", slash: ["export", "exportar"], get arg() { return `${chromeText("arg_file")} [--force] [--open]`; }, unavailable: needsConversation, run: ({ controller }, arg) => {
    const { args, hasFlag, error } = parseFlags(arg, ["forcar", "force", "abrir", "open"]);
    if (error) { controller.notice("info", error); return; }
    if (args.length > 1) { controller.notice("info", t("error_ambiguous_targets")); return; }
    const target = args[0] || `uptokey-conversa-${controller.state.activeConversation!.id.slice(0, 8)}.json`;
    return controller.exportConversation(target, hasFlag("forcar") || hasFlag("force"), hasFlag("abrir") || hasFlag("open"));
  } },
  { id: "chat.import", get title() { return t("command_chat_import"); }, group: "Conversa", slash: ["import", "importar"], get arg() { return chromeText("arg_file"); }, run: ({ controller }, arg) => arg.trim() ? controller.importConversations(arg.trim()) : controller.notice("info", t('informe_o_arquivo_importar_cam')) },
  { id: "chat.temporary", get title() { return t("command_chat_temporary"); }, group: "Conversa", slash: ["temporary", "temporaria", "temporario"], run: ({ controller, ui }) => { controller.newTemporaryConversation(); ui.closePanel(); } },

  { id: "context.add", get title() { return t("command_context_add"); }, group: "Contexto", slash: ["add", "adicionar"], get arg() { return chromeText("arg_path"); }, unavailable: needsProject, run: ({ controller, ui }, arg) => arg.trim() ? controller.addContext(arg.trim()) : ui.openPanel("files") },
  { id: "context.drop", get title() { return t("command_context_drop"); }, group: "Contexto", slash: ["drop", "remover"], get arg() { return chromeText("arg_path"); }, run: ({ controller }, arg) => { if (!controller.context.remove(arg.trim())) controller.notice("info", t("error_not_in_context", { path: arg.trim() || chromeText("empty") })); } },
  { id: "context.show", get title() { return t("command_context_show"); }, group: "Contexto", slash: ["context", "contexto"], keys: "Ctrl+T", run: ({ ui }) => ui.openPanel("context") },
  { id: "context.clear", get title() { return t("command_context_clear"); }, group: "Contexto", slash: ["clear-context", "limpar-contexto"], run: ({ controller }) => controller.context.clear() },
  { id: "files.pick", get title() { return t("command_files_pick"); }, group: "Contexto", slash: ["files", "arquivos"], keys: "Ctrl+P", unavailable: needsProject, run: ({ ui }) => ui.openPanel("files") },

  { id: "mode.toggle", get title() { return t("command_mode_toggle"); }, group: "Código", slash: ["mode", "modo"], keys: "Shift+Tab", get arg() { return "build|plan"; }, run: ({ controller }, arg) => {
    const value = arg.trim().toLowerCase();
    if (value.startsWith("plan")) controller.setMode("plan"); else if (value.startsWith("cons") || value.startsWith("build")) controller.setMode("build"); else controller.toggleMode();
  } },
  { id: "change.review", get title() { return t("command_change_review"); }, group: "Código", slash: ["review", "revisar"], keys: "Ctrl+R", unavailable: ({ controller }) => controller.view.proposal ? null : t("error_change_review_nenhuma_altera"), run: ({ ui }) => ui.openPanel("review") },
  { id: "change.apply", get title() { return t("command_change_apply"); }, group: "Código", slash: ["apply", "aplicar"], unavailable: ({ controller }) => controller.view.proposal ? null : t("error_change_review_nenhuma_altera"), run: ({ controller }) => controller.applyProposal() },
  { id: "change.discard", get title() { return t("command_change_discard"); }, group: "Código", slash: ["discard", "descartar"], unavailable: ({ controller }) => controller.view.proposal ? null : t("error_change_review_nenhuma_altera"), run: ({ controller }) => controller.rejectProposal() },
  { id: "change.refresh", get title() { return t("command_change_refresh"); }, group: "Código", slash: ["refresh-proposal", "atualizar-proposta"], unavailable: ({ controller }) => controller.canRefreshProposal ? null : t("error_change_refresh_nenhuma_respos"), run: async ({ controller, ui }) => { if (await controller.refreshProposal()) ui.openPanel("review"); } },
  { id: "verify.run", get title() { return t("command_verify_run"); }, group: "Código", slash: ["test", "verificar", "testar"], keys: "Ctrl+V", unavailable: needsProject, run: ({ controller }) => controller.verify(controller.view.verifyOffer ?? undefined) },
  { id: "lsp.diagnostics", get title() { return t("command_lsp_diagnostics"); }, group: "Código", slash: ["diagnostics", "diagnosticos"], get arg() { return chromeText("arg_files"); }, unavailable: needsProject, run: ({ controller }, arg) => {
    const paths = arg.trim() ? arg.trim().split(/\s+/) : controller.context.entries().map((e) => e.relativePath);
    return controller.lspDiagnostics(paths).then(() => undefined);
  } },
  { id: "lsp.rename", get title() { return t("command_lsp_rename"); }, group: "Código", slash: ["rename", "renomear"], get arg() { return chromeText("arg_rename"); }, unavailable: needsProject, run: ({ controller }, arg) => {
    const [target, name] = arg.trim().split(/\s+/);
    return target && name ? controller.lspRename(target, name) : controller.notice("info", t('uso_renomear_caminho_linha_col'));
  } },
  { id: "lsp.references", get title() { return t("command_lsp_references"); }, group: "Código", slash: ["references", "referencias"], get arg() { return chromeText("arg_position"); }, unavailable: needsProject, run: ({ controller }, arg) => controller.lspLocate("references", arg).then(() => undefined) },
  { id: "lsp.definition", get title() { return t("command_lsp_definition"); }, group: "Código", slash: ["definition", "definicao"], get arg() { return chromeText("arg_position"); }, unavailable: needsProject, run: ({ controller }, arg) => controller.lspLocate("definition", arg).then(() => undefined) },
  { id: "lsp.revoke", get title() { return t("command_lsp_revoke"); }, group: "Código", slash: ["lsp-revoke", "lsp-revogar"], unavailable: needsProject, run: ({ controller }) => controller.revokeLsp() },
  { id: "skills.show", get title() { return t("command_skills_show"); }, group: "Contexto", slash: ["skills"], unavailable: needsProject, run: ({ ui }) => ui.openPanel("skills") },
  { id: "artifacts.show", get title() { return t("command_artifacts_show"); }, group: "Projeto", slash: ["artifacts", "artefatos"], unavailable: needsProject, run: ({ controller, ui }) => { void controller.refreshArtifacts(); ui.openPanel("artifacts"); } },
  { id: "artifacts.save", get title() { return t("command_artifacts_save"); }, group: "Projeto", slash: ["save-artifact", "salvar-artefato"], get arg() { return `id ${chromeText("arg_path")} [--force]`; }, unavailable: needsProject, run: ({ controller }, arg) => {
    const { args, hasFlag, error } = parseFlags(arg, ["forcar", "force"]);
    if (error) { controller.notice("info", error); return; }
    if (args.length < 2) return controller.notice("info", t('uso_salvar_artefato_id_caminho'));
    if (args.length > 2) return controller.notice("info", t("error_ambiguous_targets"));
    return controller.saveArtifact(args[0]!, args[1]!, hasFlag("forcar") || hasFlag("force"));
  } },
  { id: "pwa.open", get title() { return t("command_pwa_open"); }, group: "Projeto", slash: ["pwa", "interface"], run: ({ controller }) => controller.openMainInterface() },
  { id: "context.link", get title() { return chromeText("context_link_title"); }, group: "Projeto", slash: ["link-context", "vincular-contexto"], arg: "request-id code", unavailable: ctx => needsConversation(ctx) ?? needsProject(ctx), run: ({ controller }, arg) => controller.approveWorkspaceContext(arg) },
  { id: "hooks.review", get title() { return t("command_hooks_review"); }, group: "Código", slash: ["hooks"], unavailable: needsProject, run: ({ controller, ui }) => { void controller.loadHooks().then(() => ui.openPanel("hooks")); } },
  { id: "autonomy.toggle", get title() { return t("command_autonomy_toggle"); }, group: "Código", slash: ["autonomy", "autonomia"], run: ({ controller }) => controller.setAutonomy(!controller.view.autonomy) },
  { id: "tools.toggle", get title() { return t("command_tools_toggle"); }, group: "Código", slash: ["tools", "ferramentas"], run: ({ controller }) => controller.setToolsEnabled(!controller.view.toolsEnabled) },
  { id: "editor.open", get title() { return t("command_editor_open"); }, group: "Código", slash: ["edit", "editar"], get arg() { return chromeText("arg_path"); }, unavailable: needsProject, run: ({ ui }, arg) => arg.trim() ? ui.openPanel("editor", arg.trim()) : ui.openPanel("files") },
  { id: "git.view", get title() { return t("command_git_view"); }, group: "Código", slash: ["git"], unavailable: needsProject, run: ({ ui, controller }) => { void controller.refreshGit(); ui.openPanel("git"); } },
  { id: "git.commit", get title() { return t("command_git_commit"); }, group: "Código", slash: ["commit"], get arg() { return chromeText("arg_message"); }, unavailable: needsProject, run: ({ controller }, arg) => arg.trim() ? controller.gitApply({ kind: "commit", message: arg.trim() }) : controller.notice("info", t('informe_a_mensagem_commit_mens')) },
  { id: "versions.restore", get title() { return t("command_versions_restore"); }, group: "Código", slash: ["restore", "restaurar", "versoes"], get arg() { return chromeText("arg_path"); }, unavailable: needsProject, run: ({ ui, controller }, arg) => arg.trim() ? ui.openPanel("versions", arg.trim()) : controller.notice("info", t('informe_o_arquivo_restaurar_ca')) },
  { id: "run.recover", get title() { return t("command_run_recover"); }, group: "Código", slash: ["recover", "recuperar"], unavailable: ({ controller }) => controller.view.attention ? null : t("error_run_recover_nenhuma_execu_o"), run: ({ ui }) => ui.openPanel("attention") },
  { id: "approvals.show", get title() { return t("command_approvals_show"); }, group: "Código", slash: ["approvals", "aprovacoes"], unavailable: ({ controller }) => controller.view.approvals.length ? null : t("error_approvals_show_nenhuma_aprova"), run: ({ ui }) => ui.openPanel("approvals") },

  { id: "project.pick", get title() { return t("command_project_pick"); }, group: "Projeto", slash: ["projects", "projetos"], get arg() { return chromeText("arg_path"); }, run: async ({ ui, controller }, arg) => { if (!arg.trim()) { ui.openPanel("projects"); return; } await controller.rebindProject(arg); if (controller.view.bindingCandidates) ui.openPanel("projects"); else ui.closePanel(); } },
  { id: "project.summary", get title() { return t("command_project_summary"); }, group: "Projeto", slash: ["summary", "resumo"], get arg() { return chromeText("arg_keywords"); }, unavailable: needsProject, run: ({ controller }, arg) => controller.summarizeProject(arg.trim() || undefined) },
  { id: "project.agents", get title() { return t("command_project_agents"); }, group: "Projeto", slash: ["agents", "agentes", "tarefas"], unavailable: needsProject, run: ({ ui }) => ui.openPanel("agents") },
  { id: "run.output", get title() { return t("command_run_output"); }, group: "Projeto", slash: ["output", "saida"], get arg() { return chromeText("arg_run_output"); }, unavailable: needsProject, run: async ({ controller }, arg) => { controller.exportRunOutput(arg); } },
  { id: "project.delegate", get title() { return t("command_project_delegate"); }, group: "Projeto", slash: ["delegate", "delegar"], get arg() { return chromeText("arg_delegation"); }, unavailable: needsProject, run: async ({ controller }, arg) => {
    const { parseDelegation } = await import("./delegation.ts");
    const spec = parseDelegation(arg);
    if ("error" in spec) { controller.notice("info", spec.error); return; }
    await controller.delegate(spec);
  } },
  { id: "project.integrate", get title() { return t("command_project_integrate"); }, group: "Projeto", slash: ["integrate", "integrar"], get arg() { return chromeText("arg_task_id"); }, unavailable: needsProject, run: ({ controller },arg) => controller.integrateDelegation(arg.trim()||undefined) },

  { id: "model.pick", get title() { return t("command_model_pick"); }, group: "Modelos", slash: ["models", "modelo", "modelos", "model"], keys: "Ctrl+L", get arg() { return "id"; }, run: ({ controller, ui }, arg) => {
    const id = arg.trim();
    if (!id) { ui.openPanel("models"); return; }
    // A typed identifier must never manufacture a destination. Exact
    // selection is allowed only for a model admitted by the live connection
    // inventory; otherwise open the real picker filtered to the query.
    // The provider that serves the model is fixed with it (a bare model left routing to guess the provider, and the
    // request reached one that does not offer it); a model offered by several providers opens the picker.
    const offering = controller.view.connections?.providers.filter((provider) => provider.eligible && provider.models.includes(id)) ?? [];
    if (offering.length === 1) void controller.selectProviderModel(id, offering[0]!.id).catch((error) => controller.notice("error", String(error instanceof Error ? error.message : error)));
    else if (offering.length === 0 && controller.state.models.some((model) => model.id === id)) controller.setModel(id);
    else ui.openPanel("models", id);
  } },
  { id: "connections.show", get title() { return t("command_connections_show"); }, group: "Modelos", slash: ["connections", "conexoes", "provedores"], run: ({ controller, ui }) => { void controller.refreshConnections(); ui.openPanel("connections"); } },
  { id: "usage.show", get title() { return t("command_usage_show"); }, group: "Modelos", slash: ["usage", "uso"], run: ({ ui }) => ui.openPanel("usage") },

  { id: "ui.help", get title() { return t("command_ui_help"); }, group: "Interface", slash: ["help", "ajuda", "?"], keys: "F1", run: ({ ui }) => ui.openPanel("help") },
  { id: "ui.expand", get title() { return t("command_ui_expand"); }, group: "Interface", slash: ["details", "detalhes"], keys: "Ctrl+O", run: ({ ui }) => ui.toggleExpanded() },
  { id: "ui.linear", get title() { return t("command_ui_linear"); }, group: "Interface", slash: ["reader", "leitor"], get arg() { return "on|off"; }, run: ({ ui }, arg) => ui.setLinear(!/^off|nao|não/i.test(arg.trim())) },
  { id: "ui.theme", get title() { return t("command_ui_theme"); }, group: "Interface", slash: ["theme", "tema"], get arg() { return chromeText("arg_name"); }, run: ({ ui }, arg) => ui.setTheme(arg.trim() || "auto") },
  { id: "ui.quit", get title() { return t("command_ui_quit"); }, group: "Interface", slash: ["quit", "sair", "exit"], run: ({ ui }) => ui.exit() },

  { id: "diag.doctor", get title() { return t("command_diag_doctor"); }, group: "Diagnóstico", slash: ["doctor", "diagnostico"], run: ({ ui }) => ui.openPanel("doctor") },
  { id: "diag.jev", get title() { return t("command_diag_jev"); }, group: "Diagnóstico", slash: ["jev"], run: ({ ui }) => ui.openPanel("jev") },
  { id: "diag.start", get title() { return t("command_diag_start"); }, group: "Diagnóstico", slash: ["start", "iniciar"], unavailable: ({ controller }) => controller.state.connection === "authenticated" ? t("error_diag_start_servi_o_j_cone") : null, run: ({ ui }) => ui.startService() },
];

/** Parses `/name args` into the command and its argument. */
export function resolveSlash(text: string): { command: CommandSpec; arg: string } | null {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const command = COMMANDS.find((c) => c.slash.includes(name));
  return command ? { command, arg: match[2] ?? "" } : null;
}

/** Subsequence fuzzy score for the palette (higher is better, null = no match). */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const c = candidate.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (!q) return 0;
  let score = 0, last = -1, qi = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] === q[qi]) { score += last === i - 1 ? 3 : 1; if (i === 0 || /[\s/._-]/.test(c[i - 1]!)) score += 2; last = i; qi++; }
  }
  return qi === q.length ? score - c.length * 0.01 : null;
}

export function searchCommands(query: string): CommandSpec[] {
  const scored = COMMANDS.map((command) => ({ command, score: Math.max(fuzzyScore(query, command.title) ?? -1, ...command.slash.map((s) => fuzzyScore(query, s) ?? -1)) }))
    .filter((entry) => entry.score >= 0);
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.command);
}

export async function runCommand(command: CommandSpec, ctx: CommandContext, arg = ""): Promise<void> {
  const reason = command.unavailable?.(ctx) ?? null;
  if (reason) { ctx.controller.notice("info", t("error_command_unavailable", { title: command.title, reason })); return; }
  await command.run(ctx, arg);
}

/** Heading of a command group in the person's language (group ids are internal). */
export function commandGroupTitle(group: string): string {
  const key = ({"Contexto":"context","Conversa":"conversation","Código":"code","Diagnóstico":"diagnostics","Interface":"interface","Modelos":"models","Projeto":"project"} as Record<string, string>)[group];
  return key ? t(`command_group_${key}`) : group;
}
