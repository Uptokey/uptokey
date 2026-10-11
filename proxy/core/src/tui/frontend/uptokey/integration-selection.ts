import { getLang, type Lang } from "../../i18n.ts"

type Messages = {
  selection_hint: string
  selection_empty: string
  selection_stale: string
  copied: string
  clipboard_busy: string
  clipboard_permission_denied: string
  clipboard_timeout: string
  clipboard_write_failed: string
  clipboard_unavailable: string
  clipboard_unconfirmed: string
  temporary_export_forbidden: string
  export_policy_unavailable: string
}

/** Every selection/export message is declared in all ten interface languages. */
export const SELECTION_MESSAGES: Record<Lang, Messages> = {
  en: {
    selection_hint: "Arrows move · Shift+arrows selects · Ctrl+Home/End · Ctrl+C copies · Esc returns",
    selection_empty: "There is no conversation text to select yet.",
    selection_stale: "The selected text changed. Select it again before copying.",
    copied: "Copied to clipboard.",
    clipboard_busy: "The clipboard is busy. Your selection is preserved; try copying again.",
    clipboard_permission_denied: "Clipboard access was denied. Your selection is preserved.",
    clipboard_timeout: "The clipboard did not respond. Your selection is preserved.",
    clipboard_write_failed: "The clipboard could not be updated. Your selection is preserved.",
    clipboard_unavailable: "No system clipboard is available. Your selection is preserved.",
    clipboard_unconfirmed: "Sent to the terminal clipboard; copying could not be confirmed. Your selection is preserved.",
    temporary_export_forbidden: "Temporary conversations do not allow copying or exporting. Choose a persistent conversation first.",
    export_policy_unavailable: "The conversation storage policy could not be verified. Copying and exporting are paused.",
  },
  "pt-BR": {
    selection_hint: "Setas movem · Shift+setas seleciona · Ctrl+Home/End · Ctrl+C copia · Esc volta",
    selection_empty: "Ainda não há texto da conversa para selecionar.",
    selection_stale: "O texto selecionado mudou. Selecione novamente antes de copiar.",
    copied: "Copiado para a área de transferência.",
    clipboard_busy: "A área de transferência está ocupada. A seleção foi preservada; tente copiar novamente.",
    clipboard_permission_denied: "O acesso à área de transferência foi negado. A seleção foi preservada.",
    clipboard_timeout: "A área de transferência não respondeu. A seleção foi preservada.",
    clipboard_write_failed: "Não foi possível atualizar a área de transferência. A seleção foi preservada.",
    clipboard_unavailable: "A área de transferência do sistema está indisponível. A seleção foi preservada.",
    clipboard_unconfirmed: "Enviado à área de transferência do terminal; a cópia não pôde ser confirmada. A seleção foi preservada.",
    temporary_export_forbidden: "Conversas temporárias não permitem copiar ou exportar. Escolha primeiro uma conversa persistente.",
    export_policy_unavailable: "Não foi possível verificar a política de armazenamento da conversa. Cópia e exportação estão pausadas.",
  },
  es: {
    selection_hint: "Flechas mueven · Mayús+flechas selecciona · Ctrl+Inicio/Fin · Ctrl+C copia · Esc vuelve",
    selection_empty: "Aún no hay texto de conversación para seleccionar.",
    selection_stale: "El texto seleccionado cambió. Selecciónalo de nuevo antes de copiar.",
    copied: "Copiado al portapapeles.",
    clipboard_busy: "El portapapeles está ocupado. Se conserva la selección; intenta copiar de nuevo.",
    clipboard_permission_denied: "Se denegó el acceso al portapapeles. Se conserva la selección.",
    clipboard_timeout: "El portapapeles no respondió. Se conserva la selección.",
    clipboard_write_failed: "No se pudo actualizar el portapapeles. Se conserva la selección.",
    clipboard_unavailable: "El portapapeles del sistema no está disponible. Se conserva la selección.",
    clipboard_unconfirmed: "Enviado al portapapeles del terminal; no se pudo confirmar la copia. Se conserva la selección.",
    temporary_export_forbidden: "Las conversaciones temporales no permiten copiar ni exportar. Elige primero una conversación persistente.",
    export_policy_unavailable: "No se pudo verificar la política de almacenamiento de la conversación. La copia y la exportación están en pausa.",
  },
  fr: {
    selection_hint: "Flèches déplacent · Maj+flèches sélectionne · Ctrl+Début/Fin · Ctrl+C copie · Échap revient",
    selection_empty: "Il n’y a pas encore de texte de conversation à sélectionner.",
    selection_stale: "Le texte sélectionné a changé. Sélectionnez-le à nouveau avant de copier.",
    copied: "Copié dans le presse-papiers.",
    clipboard_busy: "Le presse-papiers est occupé. La sélection est conservée ; réessayez de copier.",
    clipboard_permission_denied: "L’accès au presse-papiers a été refusé. La sélection est conservée.",
    clipboard_timeout: "Le presse-papiers n’a pas répondu. La sélection est conservée.",
    clipboard_write_failed: "Le presse-papiers n’a pas pu être mis à jour. La sélection est conservée.",
    clipboard_unavailable: "Le presse-papiers système est indisponible. La sélection est conservée.",
    clipboard_unconfirmed: "Envoyé au presse-papiers du terminal ; la copie n’a pas pu être confirmée. La sélection est conservée.",
    temporary_export_forbidden: "Les conversations temporaires ne permettent ni copie ni exportation. Choisissez d’abord une conversation persistante.",
    export_policy_unavailable: "La politique de stockage de la conversation n’a pas pu être vérifiée. La copie et l’exportation sont suspendues.",
  },
  de: {
    selection_hint: "Pfeile bewegen · Umschalt+Pfeile markieren · Strg+Pos1/Ende · Strg+C kopiert · Esc zurück",
    selection_empty: "Es gibt noch keinen Unterhaltungstext zum Markieren.",
    selection_stale: "Der markierte Text wurde geändert. Markieren Sie ihn vor dem Kopieren erneut.",
    copied: "In die Zwischenablage kopiert.",
    clipboard_busy: "Die Zwischenablage ist belegt. Die Auswahl bleibt erhalten; versuchen Sie erneut zu kopieren.",
    clipboard_permission_denied: "Der Zugriff auf die Zwischenablage wurde verweigert. Die Auswahl bleibt erhalten.",
    clipboard_timeout: "Die Zwischenablage antwortet nicht. Die Auswahl bleibt erhalten.",
    clipboard_write_failed: "Die Zwischenablage konnte nicht aktualisiert werden. Die Auswahl bleibt erhalten.",
    clipboard_unavailable: "Die Systemzwischenablage ist nicht verfügbar. Die Auswahl bleibt erhalten.",
    clipboard_unconfirmed: "An die Terminalzwischenablage gesendet; das Kopieren konnte nicht bestätigt werden. Die Auswahl bleibt erhalten.",
    temporary_export_forbidden: "Temporäre Unterhaltungen erlauben weder Kopieren noch Exportieren. Wählen Sie zuerst eine dauerhafte Unterhaltung.",
    export_policy_unavailable: "Die Speicherregel der Unterhaltung konnte nicht geprüft werden. Kopieren und Exportieren sind pausiert.",
  },
  it: {
    selection_hint: "Frecce spostano · Maiusc+frecce seleziona · Ctrl+Inizio/Fine · Ctrl+C copia · Esc torna",
    selection_empty: "Non c’è ancora testo della conversazione da selezionare.",
    selection_stale: "Il testo selezionato è cambiato. Selezionalo di nuovo prima di copiarlo.",
    copied: "Copiato negli appunti.",
    clipboard_busy: "Gli appunti sono occupati. La selezione è conservata; prova a copiare di nuovo.",
    clipboard_permission_denied: "L’accesso agli appunti è stato negato. La selezione è conservata.",
    clipboard_timeout: "Gli appunti non hanno risposto. La selezione è conservata.",
    clipboard_write_failed: "Non è stato possibile aggiornare gli appunti. La selezione è conservata.",
    clipboard_unavailable: "Gli appunti di sistema non sono disponibili. La selezione è conservata.",
    clipboard_unconfirmed: "Inviato agli appunti del terminale; la copia non è stata confermata. La selezione è conservata.",
    temporary_export_forbidden: "Le conversazioni temporanee non consentono copia o esportazione. Scegli prima una conversazione persistente.",
    export_policy_unavailable: "Non è stato possibile verificare la politica di archiviazione della conversazione. Copia ed esportazione sono sospese.",
  },
  ja: {
    selection_hint: "矢印で移動 · Shift+矢印で選択 · Ctrl+Home/End · Ctrl+Cでコピー · Escで戻る",
    selection_empty: "選択できる会話のテキストはまだありません。",
    selection_stale: "選択したテキストが変更されました。コピーする前に選択し直してください。",
    copied: "クリップボードにコピーしました。",
    clipboard_busy: "クリップボードが使用中です。選択は保持されています。もう一度コピーしてください。",
    clipboard_permission_denied: "クリップボードへのアクセスが拒否されました。選択は保持されています。",
    clipboard_timeout: "クリップボードから応答がありません。選択は保持されています。",
    clipboard_write_failed: "クリップボードを更新できませんでした。選択は保持されています。",
    clipboard_unavailable: "システムのクリップボードを利用できません。選択は保持されています。",
    clipboard_unconfirmed: "端末のクリップボードに送信しましたが、コピーを確認できませんでした。選択は保持されています。",
    temporary_export_forbidden: "一時的な会話ではコピーやエクスポートを利用できません。まず永続的な会話を選んでください。",
    export_policy_unavailable: "会話の保存ポリシーを確認できませんでした。コピーとエクスポートは一時停止されています。",
  },
  ko: {
    selection_hint: "화살표 이동 · Shift+화살표 선택 · Ctrl+Home/End · Ctrl+C 복사 · Esc 돌아가기",
    selection_empty: "선택할 대화 텍스트가 아직 없습니다.",
    selection_stale: "선택한 텍스트가 변경되었습니다. 복사하기 전에 다시 선택하세요.",
    copied: "클립보드에 복사했습니다.",
    clipboard_busy: "클립보드가 사용 중입니다. 선택이 유지됩니다. 다시 복사해 보세요.",
    clipboard_permission_denied: "클립보드 접근이 거부되었습니다. 선택이 유지됩니다.",
    clipboard_timeout: "클립보드가 응답하지 않았습니다. 선택이 유지됩니다.",
    clipboard_write_failed: "클립보드를 업데이트하지 못했습니다. 선택이 유지됩니다.",
    clipboard_unavailable: "시스템 클립보드를 사용할 수 없습니다. 선택이 유지됩니다.",
    clipboard_unconfirmed: "터미널 클립보드로 보냈지만 복사를 확인할 수 없습니다. 선택이 유지됩니다.",
    temporary_export_forbidden: "임시 대화에서는 복사하거나 내보낼 수 없습니다. 먼저 저장되는 대화를 선택하세요.",
    export_policy_unavailable: "대화 저장 정책을 확인하지 못했습니다. 복사와 내보내기가 일시 중지되었습니다.",
  },
  "zh-CN": {
    selection_hint: "方向键移动 · Shift+方向键选择 · Ctrl+Home/End · Ctrl+C 复制 · Esc 返回",
    selection_empty: "尚无可选择的对话文本。",
    selection_stale: "所选文本已更改。请重新选择后再复制。",
    copied: "已复制到剪贴板。",
    clipboard_busy: "剪贴板正忙。已保留选择，请重试复制。",
    clipboard_permission_denied: "剪贴板访问被拒绝。已保留选择。",
    clipboard_timeout: "剪贴板未响应。已保留选择。",
    clipboard_write_failed: "无法更新剪贴板。已保留选择。",
    clipboard_unavailable: "系统剪贴板不可用。已保留选择。",
    clipboard_unconfirmed: "已发送到终端剪贴板，但无法确认复制结果。已保留选择。",
    temporary_export_forbidden: "临时对话不允许复制或导出。请先选择持久保存的对话。",
    export_policy_unavailable: "无法验证对话存储策略。复制和导出已暂停。",
  },
  ar: {
    selection_hint: "الأسهم للتنقل · Shift+الأسهم للتحديد · Ctrl+Home/End · Ctrl+C للنسخ · Esc للرجوع",
    selection_empty: "لا يوجد نص محادثة لتحديده بعد.",
    selection_stale: "تغيّر النص المحدد. حدده مجددًا قبل النسخ.",
    copied: "تم النسخ إلى الحافظة.",
    clipboard_busy: "الحافظة مشغولة. تم الاحتفاظ بالتحديد؛ حاول النسخ مجددًا.",
    clipboard_permission_denied: "رُفض الوصول إلى الحافظة. تم الاحتفاظ بالتحديد.",
    clipboard_timeout: "لم تستجب الحافظة. تم الاحتفاظ بالتحديد.",
    clipboard_write_failed: "تعذّر تحديث الحافظة. تم الاحتفاظ بالتحديد.",
    clipboard_unavailable: "حافظة النظام غير متاحة. تم الاحتفاظ بالتحديد.",
    clipboard_unconfirmed: "أُرسل إلى حافظة الطرفية، لكن تعذّر تأكيد النسخ. تم الاحتفاظ بالتحديد.",
    temporary_export_forbidden: "لا تسمح المحادثات المؤقتة بالنسخ أو التصدير. اختر محادثة دائمة أولًا.",
    export_policy_unavailable: "تعذّر التحقق من سياسة تخزين المحادثة. تم إيقاف النسخ والتصدير مؤقتًا.",
  },
}

export function selectionUi(key: keyof Messages, lang: Lang = getLang()): string {
  return SELECTION_MESSAGES[lang][key]
}
