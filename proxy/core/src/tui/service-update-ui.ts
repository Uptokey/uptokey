import { getLang, type Lang } from "./i18n.ts";

const row = (en: string, pt: string, es: string, fr: string, de: string, it: string, ja: string, ko: string, zh: string, ar: string): Record<Lang, string> => ({ en, "pt-BR": pt, es, fr, de, it, ja, ko, "zh-CN": zh, ar });
export const SERVICE_UPDATE_STRINGS = {
  confirm: row(
    "Update local service? This restarts connections; saved conversations and keys stay. [y/N] ",
    "Atualizar o serviço local? Isso reinicia conexões; conversas salvas e chaves permanecem. [s/N] ",
    "¿Actualizar el servicio local? Se reinician las conexiones; las conversaciones guardadas y las claves se conservan. [s/N] ",
    "Mettre à jour le service local ? Les connexions redémarrent ; les conversations enregistrées et les clés sont conservées. [o/N] ",
    "Lokalen Dienst aktualisieren? Verbindungen werden neu gestartet; gespeicherte Chats und Schlüssel bleiben erhalten. [j/N] ",
    "Aggiornare il servizio locale? Le connessioni si riavviano; conversazioni salvate e chiavi restano. [s/N] ",
    "ローカルサービスを更新しますか？接続は再起動しますが、保存した会話とキーは保持されます。[y/N] ",
    "로컬 서비스를 업데이트할까요? 연결이 다시 시작되며 저장된 대화와 키는 유지됩니다. [y/N] ",
    "更新本地服务？连接将重启，已保存的对话和密钥会保留。[y/N] ",
    "تحديث الخدمة المحلية؟ ستُعاد الاتصالات مع الاحتفاظ بالمحادثات المحفوظة والمفاتيح. [y/N] ",
  ),
  needed: row(
    "Using the existing service. Update it to use this version’s Free models.",
    "Usando o serviço existente. Atualize-o para usar os modelos Free desta versão.",
    "Se mantiene el servicio actual. Actualízalo para usar los modelos Free de esta versión.",
    "Le service existant reste utilisé. Mettez-le à jour pour les modèles Free de cette version.",
    "Der bisherige Dienst bleibt aktiv. Für die Free-Modelle dieser Version bitte aktualisieren.",
    "Resta in uso il servizio esistente. Aggiornalo per i modelli Free di questa versione.",
    "既存のサービスを使用します。このバージョンのFreeモデルを使うには更新してください。",
    "기존 서비스를 사용합니다. 이 버전의 Free 모델을 사용하려면 업데이트하세요.",
    "继续使用现有服务。请更新服务以使用此版本的 Free 模型。",
    "تستمر الخدمة الحالية. حدّثها لاستخدام نماذج Free في هذا الإصدار.",
  ),
  unknown: row(
    "Using the existing service; its version could not be checked. Free model availability may differ.",
    "Usando o serviço existente; não foi possível conferir a versão. A disponibilidade dos modelos Free pode variar.",
    "Se mantiene el servicio actual; no se pudo comprobar su versión. Los modelos Free disponibles pueden variar.",
    "Le service existant reste utilisé ; sa version est inconnue. Les modèles Free disponibles peuvent varier.",
    "Der bisherige Dienst bleibt aktiv; seine Version ist unbekannt. Verfügbare Free-Modelle können abweichen.",
    "Resta in uso il servizio esistente; versione non verificabile. I modelli Free disponibili possono variare.",
    "既存のサービスを使用します。バージョンを確認できないため、利用可能なFreeモデルが異なる場合があります。",
    "기존 서비스를 사용합니다. 버전을 확인할 수 없어 사용 가능한 Free 모델이 다를 수 있습니다.",
    "继续使用现有服务；无法确认其版本。可用的 Free 模型可能不同。",
    "تستمر الخدمة الحالية؛ تعذّر التحقق من إصدارها. قد تختلف نماذج Free المتاحة.",
  ),
  failed: row(
    "The local service update did not finish. Your saved data was kept. Reopen Uptokey to retry.",
    "A atualização do serviço local não terminou. Seus dados salvos foram mantidos. Reabra o Uptokey para tentar novamente.",
    "La actualización del servicio local no terminó. Tus datos guardados se conservaron. Reabre Uptokey para reintentar.",
    "La mise à jour du service local n’a pas abouti. Vos données enregistrées sont conservées. Rouvrez Uptokey pour réessayer.",
    "Das Update des lokalen Dienstes wurde nicht abgeschlossen. Gespeicherte Daten bleiben erhalten. Uptokey erneut öffnen und versuchen.",
    "L’aggiornamento del servizio locale non è terminato. I dati salvati sono conservati. Riapri Uptokey per riprovare.",
    "ローカルサービスの更新が完了しませんでした。保存データは保持されています。Uptokeyを開き直して再試行してください。",
    "로컬 서비스 업데이트가 완료되지 않았습니다. 저장된 데이터는 유지됩니다. Uptokey를 다시 열어 재시도하세요.",
    "本地服务更新未完成。已保存的数据仍保留。请重新打开 Uptokey 后重试。",
    "لم يكتمل تحديث الخدمة المحلية. حُفظت بياناتك المسجلة. أعد فتح Uptokey للمحاولة مجددًا.",
  ),
} as const;

export const serviceUpdateText = (key: keyof typeof SERVICE_UPDATE_STRINGS, lang = getLang()) => SERVICE_UPDATE_STRINGS[key][lang];
export const serviceUpdateAccepted = (answer: string) => /^(y|yes|s|sim|sí|si|o|oui|j|ja|はい|네|是|نعم)$/iu.test(answer.trim());
