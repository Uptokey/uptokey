/** Translations of the versioned canonical disclosures; consent versions and source policies stay canonical. */
import { getLang, type Lang } from "./i18n.ts"
import { NAMED_PROVIDER_RISK_NOTICES } from "../provider-risk.ts"
import type { NamedExperimentalProviderName } from "../provider-registry.ts"

type NoticeProvider = "gemini" | NamedExperimentalProviderName
const row = (en: string, pt: string, es: string, fr: string, de: string, it: string, ja: string, ko: string, zh: string, ar: string): Record<Lang, string> =>
  ({ en, "pt-BR": pt, es, fr, de, it, ja, ko, "zh-CN": zh, ar })

export const PROVIDER_NOTICE_MESSAGES: Record<NoticeProvider, Record<Lang, string>> = {
  gemini: row(
    "Gemini free tier: Google may use prompts and responses to improve products, including human review. In Brazil, this use is not covered by the regional exception. Do not send sensitive personal data, secrets, clinical data or confidential content.",
    "Plano gratuito do Gemini: o Google pode usar prompts e respostas para melhorar produtos, incluindo revisão humana. No Brasil, esta utilização não está na exceção regional. Não envie dados pessoais sensíveis, segredos, dados clínicos ou conteúdo confidencial.",
    "Plan gratuito de Gemini: Google puede usar las solicitudes y respuestas para mejorar sus productos, incluida la revisión humana. En Brasil, este uso no está cubierto por la excepción regional. No envíes datos personales sensibles, secretos, datos clínicos ni contenido confidencial.",
    "Offre gratuite de Gemini : Google peut utiliser les requêtes et les réponses pour améliorer ses produits, y compris avec une révision humaine. Au Brésil, cette utilisation n’est pas couverte par l’exception régionale. N’envoyez pas de données personnelles sensibles, de secrets, de données cliniques ou de contenu confidentiel.",
    "Kostenlose Gemini-Stufe: Google kann Eingaben und Antworten zur Verbesserung seiner Produkte verwenden, einschließlich menschlicher Prüfung. In Brasilien fällt diese Nutzung nicht unter die regionale Ausnahme. Senden Sie keine sensiblen personenbezogenen Daten, Geheimnisse, klinischen Daten oder vertraulichen Inhalte.",
    "Piano gratuito di Gemini: Google può usare richieste e risposte per migliorare i prodotti, anche tramite revisione umana. In Brasile questo uso non rientra nell’eccezione regionale. Non inviare dati personali sensibili, segreti, dati clinici o contenuti riservati.",
    "Geminiの無料プランでは、Googleが入力と応答を製品改善に利用し、人による確認を行う場合があります。ブラジルでは、この利用は地域例外の対象外です。機微な個人情報、秘密情報、臨床データ、機密の内容を送信しないでください。",
    "Gemini 무료 요금제에서는 Google이 제품 개선을 위해 입력과 응답을 사용하고 사람이 검토할 수 있습니다. 브라질에서는 이 사용에 지역 예외가 적용되지 않습니다. 민감한 개인정보, 비밀 정보, 임상 데이터 또는 기밀 내용을 보내지 마세요.",
    "Gemini 免费方案：Google 可能使用输入和回复来改进产品，包括人工审核。在巴西，此用途不属于地区例外。请勿发送敏感个人数据、秘密信息、临床数据或机密内容。",
    "خطة Gemini المجانية: قد تستخدم Google المدخلات والردود لتحسين المنتجات، بما في ذلك المراجعة البشرية. في البرازيل، لا يشمل الاستثناء الإقليمي هذا الاستخدام. لا ترسل بيانات شخصية حساسة أو أسرارًا أو بيانات سريرية أو محتوى سريًا."
  ),
  deepseek: row(
    "Tier 3, managed by you. Requests are sent to the DeepSeek API. Open Platform terms permit downstream integrations and place responsibilities toward their users on developers. Do not assume zero retention; check the policy applicable to your account before sending sensitive data.",
    "Nível 3, gerenciado por você. A solicitação é enviada à API DeepSeek. Os termos da Open Platform permitem integrações downstream e atribuem ao desenvolvedor responsabilidades perante seus usuários. Não presuma retenção zero; consulte a política aplicável à sua conta antes de enviar dados sensíveis.",
    "Nivel 3, gestionado por ti. Las solicitudes se envían a la API de DeepSeek. Los términos de Open Platform permiten integraciones derivadas y atribuyen al desarrollador responsabilidades ante sus usuarios. No presupongas retención cero; consulta la política aplicable a tu cuenta antes de enviar datos sensibles.",
    "Niveau 3, géré par vous. Les requêtes sont envoyées à l’API DeepSeek. Les conditions d’Open Platform autorisent les intégrations en aval et imposent aux développeurs des responsabilités envers leurs utilisateurs. Ne supposez pas une conservation nulle ; consultez la politique applicable à votre compte avant d’envoyer des données sensibles.",
    "Stufe 3, von Ihnen verwaltet. Anfragen werden an die DeepSeek-API gesendet. Die Open-Platform-Bedingungen erlauben nachgelagerte Integrationen und übertragen Entwicklern Verantwortung gegenüber ihren Nutzern. Gehen Sie nicht von fehlender Datenspeicherung aus; prüfen Sie vor dem Senden sensibler Daten die für Ihr Konto geltenden Regeln.",
    "Livello 3, gestito da te. Le richieste vengono inviate all’API DeepSeek. I termini di Open Platform consentono integrazioni a valle e attribuiscono agli sviluppatori responsabilità verso i propri utenti. Non presumere conservazione zero; consulta la politica applicabile al tuo account prima di inviare dati sensibili.",
    "レベル3、利用者が管理する接続です。リクエストはDeepSeek APIに送信されます。Open Platformの規約は下流の統合を認め、開発者に利用者への責任を課しています。データが保持されないと決めつけず、機微なデータを送る前にアカウントに適用される方針を確認してください。",
    "3단계, 사용자가 관리하는 연결입니다. 요청은 DeepSeek API로 전송됩니다. Open Platform 약관은 후속 통합을 허용하며 개발자에게 사용자에 대한 책임을 부여합니다. 데이터가 보존되지 않는다고 가정하지 말고 민감한 데이터를 보내기 전에 계정에 적용되는 정책을 확인하세요.",
    "第 3 级，由您管理。请求发送到 DeepSeek API。Open Platform 条款允许下游集成，并要求开发者对其用户承担责任。请勿假定数据完全不保留；发送敏感数据前，请查看适用于您账户的政策。",
    "المستوى 3، بإدارتك. تُرسل الطلبات إلى واجهة DeepSeek. تسمح شروط Open Platform بالتكاملات اللاحقة وتحمّل المطوّرين مسؤوليات تجاه مستخدميهم. لا تفترض انعدام الاحتفاظ بالبيانات؛ راجع السياسة المطبقة على حسابك قبل إرسال بيانات حساسة."
  ),
  mistral: row(
    "Tier 3, managed by you. The API policy describes default retention of inputs and outputs for up to 30 days for abuse monitoring unless zero data retention (ZDR) is enabled. Specific APIs, including Agents and Fine-Tuning, have their own rules; confirm the configuration and endpoint you use.",
    "Nível 3, gerenciado por você. A política da API descreve retenção padrão de entradas e saídas por até 30 dias para monitoramento de abuso, salvo ativação de retenção zero de dados (ZDR). APIs específicas, incluindo Agents e Fine-Tuning, têm regras próprias; confirme a configuração e o endpoint usados.",
    "Nivel 3, gestionado por ti. La política de la API describe una retención predeterminada de entradas y salidas de hasta 30 días para vigilar abusos, salvo que se active la retención cero de datos (ZDR). Algunas API, incluidas Agents y Fine-Tuning, tienen reglas propias; confirma la configuración y el punto de conexión utilizados.",
    "Niveau 3, géré par vous. La politique de l’API décrit une conservation par défaut des entrées et sorties jusqu’à 30 jours pour surveiller les abus, sauf activation de la conservation nulle des données (ZDR). Certaines API, notamment Agents et Fine-Tuning, ont leurs propres règles ; vérifiez la configuration et le point de terminaison utilisés.",
    "Stufe 3, von Ihnen verwaltet. Die API-Richtlinie beschreibt eine standardmäßige Speicherung von Eingaben und Ausgaben für bis zu 30 Tage zur Missbrauchsüberwachung, sofern keine Nullspeicherung (ZDR) aktiviert ist. Bestimmte APIs, darunter Agents und Fine-Tuning, haben eigene Regeln; prüfen Sie die verwendete Konfiguration und den Endpunkt.",
    "Livello 3, gestito da te. La politica dell’API prevede la conservazione predefinita di input e output fino a 30 giorni per monitorare gli abusi, salvo attivazione della conservazione zero dei dati (ZDR). API specifiche, incluse Agents e Fine-Tuning, hanno regole proprie; verifica la configurazione e l’endpoint usati.",
    "レベル3、利用者が管理する接続です。APIの方針では、不正利用の監視のため入力と出力を標準で最大30日間保持し、ゼロデータ保持（ZDR）を有効にした場合は例外としています。AgentsやFine-Tuningなど特定のAPIには独自の規則があるため、利用する設定とエンドポイントを確認してください。",
    "3단계, 사용자가 관리하는 연결입니다. API 정책에 따르면 제로 데이터 보존(ZDR)을 활성화하지 않는 한 악용 감시를 위해 입력과 출력을 기본적으로 최대 30일 보존합니다. Agents와 Fine-Tuning 등 특정 API에는 별도 규칙이 있으므로 사용하는 설정과 엔드포인트를 확인하세요.",
    "第 3 级，由您管理。API 政策说明，默认将输入和输出保留最多 30 天用于滥用监控，除非已启用零数据保留（ZDR）。某些 API，包括 Agents 和 Fine-Tuning，有各自的规则；请确认所用配置和端点。",
    "المستوى 3، بإدارتك. تصف سياسة الواجهة الاحتفاظ الافتراضي بالمدخلات والمخرجات لمدة تصل إلى 30 يومًا لمراقبة إساءة الاستخدام، ما لم يُفعّل عدم الاحتفاظ بالبيانات (ZDR). لواجهات محددة، منها Agents وFine-Tuning، قواعد خاصة؛ تأكد من الإعداد ونقطة الاتصال المستخدمين."
  ),
  cerebras: row(
    "Tier 3, managed by you. The reviewed policy states that inputs and outputs associated with inference services are not retained; personal data and operational logs follow the policy’s own retention periods and exceptions. Confirm the terms applicable to your API and account.",
    "Nível 3, gerenciado por você. A política consultada diz que entradas e saídas associadas aos serviços de inferência não são retidas; dados pessoais e logs operacionais seguem os prazos e exceções da própria política. Confirme os termos aplicáveis à sua API e conta.",
    "Nivel 3, gestionado por ti. La política consultada indica que no se conservan las entradas y salidas de los servicios de inferencia; los datos personales y registros operativos siguen los plazos y excepciones de la propia política. Confirma los términos aplicables a tu API y cuenta.",
    "Niveau 3, géré par vous. La politique consultée indique que les entrées et sorties des services d’inférence ne sont pas conservées ; les données personnelles et journaux opérationnels suivent les durées et exceptions prévues par cette politique. Vérifiez les conditions applicables à votre API et à votre compte.",
    "Stufe 3, von Ihnen verwaltet. Laut der geprüften Richtlinie werden Eingaben und Ausgaben der Inferenzdienste nicht gespeichert; für personenbezogene Daten und Betriebsprotokolle gelten die Fristen und Ausnahmen dieser Richtlinie. Prüfen Sie die für Ihre API und Ihr Konto geltenden Bedingungen.",
    "Livello 3, gestito da te. La politica consultata dichiara che input e output dei servizi di inferenza non vengono conservati; dati personali e registri operativi seguono i termini e le eccezioni della stessa politica. Verifica i termini applicabili alla tua API e al tuo account.",
    "レベル3、利用者が管理する接続です。確認済みの方針では、推論サービスの入力と出力は保持されません。個人情報と運用ログには、その方針に定められた保持期間と例外が適用されます。APIとアカウントに適用される規約を確認してください。",
    "3단계, 사용자가 관리하는 연결입니다. 검토된 정책에 따르면 추론 서비스의 입력과 출력은 보존되지 않으며 개인정보와 운영 로그에는 정책 자체의 보존 기간과 예외가 적용됩니다. API와 계정에 적용되는 약관을 확인하세요.",
    "第 3 级，由您管理。已查阅的政策说明，不保留推理服务相关的输入和输出；个人数据和运营日志则遵循该政策自身的保留期限及例外。请确认适用于您 API 和账户的条款。",
    "المستوى 3، بإدارتك. تنص السياسة التي روجعت على عدم الاحتفاظ بمدخلات خدمات الاستدلال ومخرجاتها؛ وتخضع البيانات الشخصية والسجلات التشغيلية للمدد والاستثناءات المحددة في السياسة نفسها. تأكد من الشروط المطبقة على واجهتك وحسابك."
  ),
  together: row(
    "Tier 3, managed by you. The terms state that zero data retention (ZDR) applies only after it is enabled for the account. They also restrict using the service to develop a competing product or service; assess whether this applies to your use before enabling it.",
    "Nível 3, gerenciado por você. Os termos dizem que a retenção zero de dados (ZDR) só vale a partir da ativação na conta. Também restringem o uso do serviço para desenvolver produto ou serviço competitivo; avalie se isso se aplica ao seu uso antes de ativar.",
    "Nivel 3, gestionado por ti. Los términos indican que la retención cero de datos (ZDR) solo se aplica tras activarla en la cuenta. También restringen el uso del servicio para desarrollar un producto o servicio competidor; evalúa si esto afecta a tu uso antes de activarlo.",
    "Niveau 3, géré par vous. Les conditions indiquent que la conservation nulle des données (ZDR) ne s’applique qu’après son activation sur le compte. Elles limitent également l’utilisation du service pour développer un produit ou service concurrent ; évaluez si cette restriction concerne votre usage avant l’activation.",
    "Stufe 3, von Ihnen verwaltet. Laut den Bedingungen gilt Nullspeicherung (ZDR) erst ab ihrer Aktivierung für das Konto. Die Nutzung des Dienstes zur Entwicklung eines konkurrierenden Produkts oder Dienstes ist ebenfalls eingeschränkt; prüfen Sie vor der Aktivierung, ob dies Ihren Einsatz betrifft.",
    "Livello 3, gestito da te. I termini indicano che la conservazione zero dei dati (ZDR) vale solo dopo l’attivazione sull’account. Limitano inoltre l’uso del servizio per sviluppare prodotti o servizi concorrenti; valuta se questo riguarda il tuo uso prima di attivarlo.",
    "レベル3、利用者が管理する接続です。規約では、ゼロデータ保持（ZDR）はアカウントで有効にした時点からのみ適用されます。また、競合する製品やサービスの開発にこのサービスを使うことを制限しています。有効にする前に、自分の用途に該当するか確認してください。",
    "3단계, 사용자가 관리하는 연결입니다. 약관에 따르면 제로 데이터 보존(ZDR)은 계정에서 활성화한 시점부터만 적용됩니다. 경쟁 제품이나 서비스를 개발하기 위한 서비스 사용도 제한하므로 활성화 전에 자신의 용도에 해당하는지 검토하세요.",
    "第 3 级，由您管理。条款说明，零数据保留（ZDR）仅在账户启用后生效。条款还限制使用此服务开发竞争产品或服务；启用前，请评估这是否适用于您的用途。",
    "المستوى 3، بإدارتك. تنص الشروط على أن عدم الاحتفاظ بالبيانات (ZDR) لا يسري إلا بعد تفعيله في الحساب. وتقيّد أيضًا استخدام الخدمة لتطوير منتج أو خدمة منافسة؛ قيّم انطباق ذلك على استخدامك قبل التفعيل."
  ),
  anthropic: row(
    "Tier 3, managed by you. For the commercial API, default retention of inputs and outputs is up to 30 days, with exceptions; zero data retention (ZDR) requires approval and an applicable agreement. Check which products and features are covered by your organization’s configuration.",
    "Nível 3, gerenciado por você. Na API comercial, a retenção padrão de entradas e saídas é de até 30 dias, com exceções; a retenção zero de dados (ZDR) depende de aprovação e acordo aplicável. Confira quais produtos e recursos estão cobertos pela configuração da sua organização.",
    "Nivel 3, gestionado por ti. En la API comercial, la retención predeterminada de entradas y salidas es de hasta 30 días, con excepciones; la retención cero de datos (ZDR) requiere aprobación y un acuerdo aplicable. Comprueba qué productos y funciones cubre la configuración de tu organización.",
    "Niveau 3, géré par vous. Pour l’API commerciale, les entrées et sorties sont conservées par défaut jusqu’à 30 jours, avec des exceptions ; la conservation nulle des données (ZDR) nécessite une approbation et un accord applicable. Vérifiez les produits et fonctionnalités couverts par la configuration de votre organisation.",
    "Stufe 3, von Ihnen verwaltet. Bei der kommerziellen API beträgt die standardmäßige Speicherung von Eingaben und Ausgaben bis zu 30 Tage, mit Ausnahmen; Nullspeicherung (ZDR) erfordert eine Genehmigung und eine entsprechende Vereinbarung. Prüfen Sie, welche Produkte und Funktionen Ihre Organisationskonfiguration abdeckt.",
    "Livello 3, gestito da te. Nell’API commerciale, input e output vengono conservati per impostazione predefinita fino a 30 giorni, con eccezioni; la conservazione zero dei dati (ZDR) richiede approvazione e un accordo applicabile. Verifica quali prodotti e funzioni sono coperti dalla configurazione della tua organizzazione.",
    "レベル3、利用者が管理する接続です。商用APIでは、入力と出力の標準の保持期間は最大30日で、例外があります。ゼロデータ保持（ZDR）には承認と適用される契約が必要です。組織の設定がどの製品と機能を対象としているか確認してください。",
    "3단계, 사용자가 관리하는 연결입니다. 상업용 API의 입력과 출력은 예외를 제외하고 기본적으로 최대 30일 보존되며, 제로 데이터 보존(ZDR)에는 승인과 적용 가능한 계약이 필요합니다. 조직의 설정이 어떤 제품과 기능을 포함하는지 확인하세요.",
    "第 3 级，由您管理。商业 API 默认将输入和输出保留最多 30 天，并有例外；零数据保留（ZDR）需要批准及适用协议。请查看您组织的配置涵盖哪些产品和功能。",
    "المستوى 3، بإدارتك. في الواجهة التجارية، تصل مدة الاحتفاظ الافتراضية بالمدخلات والمخرجات إلى 30 يومًا، مع استثناءات؛ ويتطلب عدم الاحتفاظ بالبيانات (ZDR) موافقة واتفاقًا مطبقًا. تحقق من المنتجات والميزات التي يشملها إعداد مؤسستك."
  ),
  openrouter: row(
    "Tier 3, managed by you. Inputs are sent to OpenRouter and to the provider of the selected model. Retention and training practices vary between providers; OpenRouter states that it does not use inputs and outputs for its own training. This connection uses your OpenRouter account, not an Uptokey-hosted gateway.",
    "Nível 3, gerenciado por você. A entrada segue para a OpenRouter e para o provedor do modelo selecionado. As práticas de retenção e treinamento variam entre provedores; a OpenRouter declara que não usa entradas e saídas para treinamento próprio. Esta conexão usa sua conta OpenRouter, não um gateway hospedado pela Uptokey.",
    "Nivel 3, gestionado por ti. Las entradas se envían a OpenRouter y al proveedor del modelo seleccionado. La retención y el entrenamiento varían entre proveedores; OpenRouter declara que no usa las entradas y salidas para su propio entrenamiento. Esta conexión usa tu cuenta OpenRouter, no una pasarela alojada por Uptokey.",
    "Niveau 3, géré par vous. Les entrées sont envoyées à OpenRouter et au fournisseur du modèle sélectionné. Les pratiques de conservation et d’entraînement varient selon les fournisseurs ; OpenRouter déclare ne pas utiliser les entrées et sorties pour son propre entraînement. Cette connexion utilise votre compte OpenRouter, et non une passerelle hébergée par Uptokey.",
    "Stufe 3, von Ihnen verwaltet. Eingaben werden an OpenRouter und an den Anbieter des gewählten Modells gesendet. Speicherung und Training unterscheiden sich je nach Anbieter; OpenRouter erklärt, Eingaben und Ausgaben nicht für eigenes Training zu verwenden. Diese Verbindung nutzt Ihr OpenRouter-Konto und kein von Uptokey gehostetes Gateway.",
    "Livello 3, gestito da te. Gli input vengono inviati a OpenRouter e al fornitore del modello selezionato. Le pratiche di conservazione e addestramento variano tra i fornitori; OpenRouter dichiara di non usare input e output per il proprio addestramento. Questa connessione usa il tuo account OpenRouter, non un gateway ospitato da Uptokey.",
    "レベル3、利用者が管理する接続です。入力はOpenRouterと、選択したモデルの提供元に送られます。保持や学習への利用は提供元ごとに異なります。OpenRouterは入力と出力を自社の学習に使わないと表明しています。この接続では利用者のOpenRouterアカウントを使い、Uptokeyがホストするゲートウェイは使いません。",
    "3단계, 사용자가 관리하는 연결입니다. 입력은 OpenRouter와 선택한 모델의 제공자에게 전송됩니다. 보존 및 학습 관행은 제공자마다 다르며, OpenRouter는 자체 학습에 입력과 출력을 사용하지 않는다고 밝힙니다. 이 연결은 Uptokey가 호스팅하는 게이트웨이가 아닌 사용자의 OpenRouter 계정을 사용합니다.",
    "第 3 级，由您管理。输入发送到 OpenRouter 及所选模型的提供商。不同提供商的保留和训练做法有所不同；OpenRouter 声明不会将输入和输出用于自身训练。此连接使用您的 OpenRouter 账户，而非 Uptokey 托管的网关。",
    "المستوى 3، بإدارتك. تُرسل المدخلات إلى OpenRouter وإلى مزوّد النموذج المختار. تختلف ممارسات الاحتفاظ والتدريب بين المزوّدين؛ وتصرّح OpenRouter بأنها لا تستخدم المدخلات والمخرجات لتدريبها الخاص. يستخدم هذا الاتصال حسابك لدى OpenRouter، وليس بوابة تستضيفها Uptokey."
  ),
}

/** Source URLs come from the same canonical records whose versions govern acceptance. */
export function providerNoticeText(provider: string, language = getLang()): string | undefined {
  if (provider === "gemini") return PROVIDER_NOTICE_MESSAGES.gemini[language]
  if (!Object.hasOwn(NAMED_PROVIDER_RISK_NOTICES, provider)) return undefined
  const named = provider as NamedExperimentalProviderName
  return `${PROVIDER_NOTICE_MESSAGES[named][language]}\n${NAMED_PROVIDER_RISK_NOTICES[named].sourceUrl}`
}
