/** Batch 5 (see fill-1.ts). Row order: es, fr, de, it, ja, ko, zh-CN, ar. */
export const FILL_5: Record<string, readonly [string, string, string, string, string, string, string, string]> = {
  comparison_finished: ["{title}: {status} · {answered}/{total} modelos respondieron.", "{title} : {status} · {answered}/{total} modèles ont répondu.", "{title}: {status} · {answered}/{total} Modelle haben geantwortet.", "{title}: {status} · {answered}/{total} modelli hanno risposto.", "{title}: {status} · {answered}/{total} モデルが応答しました。", "{title}: {status} · 모델 {total}개 중 {answered}개가 응답했습니다.", "{title}：{status} · {answered}/{total} 个模型已回复。", "{title}: {status} · استجاب {answered} من {total} نماذج."],
  comparison_branch_failed: ["{model}: falló ({code})", "{model} : échec ({code})", "{model}: fehlgeschlagen ({code})", "{model}: non riuscito ({code})", "{model}: 失敗（{code}）", "{model}: 실패({code})", "{model}：失败（{code}）", "{model}: فشل ({code})"],
}

/** Run/branch states shown after a comparison or delegation. Row order: es, fr, de, it, ja, ko, zh-CN, ar. */
export const FILL_5_STATUS: Record<string, readonly [string, string, string, string, string, string, string, string]> = {
  run_status_draft: ["borrador", "brouillon", "Entwurf", "bozza", "下書き", "초안", "草稿", "مسودة"],
  run_status_running: ["en curso", "en cours", "läuft", "in corso", "実行中", "실행 중", "运行中", "قيد التشغيل"],
  run_status_succeeded: ["completado", "terminé", "abgeschlossen", "completato", "完了", "완료", "已完成", "مكتمل"],
  run_status_failed: ["falló", "échec", "fehlgeschlagen", "non riuscito", "失敗", "실패", "失败", "فشل"],
  run_status_cancelled: ["cancelado", "annulé", "abgebrochen", "annullato", "キャンセル済み", "취소됨", "已取消", "أُلغي"],
  run_status_needs_attention: ["requiere atención", "demande attention", "braucht Aufmerksamkeit", "richiede attenzione", "対応が必要", "주의 필요", "需要关注", "يحتاج إلى انتباه"],
  run_status_partial: ["parcial", "partiel", "teilweise", "parziale", "一部完了", "부분 완료", "部分完成", "جزئي"],
  run_status_pending: ["pendiente", "en attente", "ausstehend", "in attesa", "保留中", "대기 중", "待处理", "معلّق"],
  run_status_unknown: ["desconocido", "inconnu", "unbekannt", "sconosciuto", "不明", "알 수 없음", "未知", "غير معروف"],
}

export const FILL_5_MORE: Record<string, readonly [string, string, string, string, string, string, string, string]> = {
  comparisons_none: ["No hay ejecuciones multimodelo en este proyecto.", "Aucune exécution multimodèle dans ce projet.", "Keine Mehrmodell-Ausführungen in diesem Projekt.", "Nessuna esecuzione multimodello in questo progetto.", "このプロジェクトにマルチモデル実行はありません。", "이 프로젝트에는 다중 모델 실행이 없습니다.", "此项目中没有多模型执行。", "لا توجد عمليات تنفيذ متعددة النماذج في هذا المشروع."],
}
