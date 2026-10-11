/** Connection/context recovery strings. Every row requires all ten supported languages. */
import { getLang, type Lang } from "../../i18n.ts"
import type { PreparedProviderSetup, ProviderSetupService } from "../../provider-setup.ts"
import { ui } from "./i18n.ts"

type Entry = Record<Lang, string>
const row = (en: string, pt: string, es: string, fr: string, de: string, it: string, ja: string, ko: string, zh: string, ar: string): Entry =>
  ({ en, "pt-BR": pt, es, fr, de, it, ja, ko, "zh-CN": zh, ar })

export const CONNECTION_STRINGS = {
  region_or_key: row("Check the key and API region.", "Confira a chave e a região da API.", "Comprueba la clave y la región de la API.", "Vérifiez la clé et la région de l’API.", "Schlüssel und API-Region prüfen.", "Verifica la chiave e la regione API.", "キーとAPIのリージョンを確認してください。", "키와 API 리전을 확인하세요.", "请检查密钥和 API 区域。", "تحقق من المفتاح ومنطقة الواجهة."),
  access_denied: row("Check API permissions and project access.", "Confira as permissões da API e o acesso ao projeto.", "Comprueba los permisos de la API y el acceso al proyecto.", "Vérifiez les autorisations API et l’accès au projet.", "API-Berechtigungen und Projektzugriff prüfen.", "Verifica i permessi API e l’accesso al progetto.", "APIの権限とプロジェクトへのアクセスを確認してください。", "API 권한과 프로젝트 접근 권한을 확인하세요.", "请检查 API 权限和项目访问权限。", "تحقق من أذونات الواجهة والوصول إلى المشروع."),
  key_restricted: row("Check this key’s API and application restrictions.", "Confira as restrições de API e aplicativo desta chave.", "Comprueba las restricciones de API y aplicación de esta clave.", "Vérifiez les restrictions d’API et d’application de cette clé.", "API- und Anwendungseinschränkungen dieses Schlüssels prüfen.", "Verifica le restrizioni API e applicazione della chiave.", "このキーのAPIとアプリケーションの制限を確認してください。", "이 키의 API 및 애플리케이션 제한을 확인하세요.", "请检查此密钥的 API 和应用限制。", "تحقق من قيود الواجهة والتطبيق لهذا المفتاح."),
  service_disabled: row("Enable this API in the provider’s project settings.", "Ative esta API nas configurações do projeto no provedor.", "Activa esta API en los ajustes del proyecto del proveedor.", "Activez cette API dans les paramètres du projet du fournisseur.", "Diese API in den Projekteinstellungen des Anbieters aktivieren.", "Abilita questa API nelle impostazioni del progetto del fornitore.", "プロバイダーのプロジェクト設定でこのAPIを有効にしてください。", "공급자 프로젝트 설정에서 이 API를 활성화하세요.", "请在提供商的项目设置中启用此 API。", "فعّل هذه الواجهة في إعدادات المشروع لدى المزوّد."),
  billing_required: row("Check billing or credits in your provider account.", "Confira o faturamento ou os créditos na conta do provedor.", "Comprueba la facturación o los créditos de tu cuenta del proveedor.", "Vérifiez la facturation ou les crédits de votre compte fournisseur.", "Abrechnung oder Guthaben im Anbieterkonto prüfen.", "Verifica la fatturazione o i crediti del tuo account fornitore.", "プロバイダーのアカウントで請求設定または残高を確認してください。", "공급자 계정의 결제 설정 또는 크레딧을 확인하세요.", "请检查提供商账户的结算或余额。", "تحقق من الفوترة أو الرصيد في حساب المزوّد."),
  setup_required: row("Complete API setup in your provider account, then retry.", "Conclua a configuração da API na conta do provedor e tente novamente.", "Completa la configuración de la API en tu cuenta y reintenta.", "Terminez la configuration API dans votre compte fournisseur puis réessayez.", "API-Einrichtung im Anbieterkonto abschließen und erneut versuchen.", "Completa la configurazione API nell’account fornitore e riprova.", "プロバイダーのアカウントでAPI設定を完了して再試行してください。", "공급자 계정에서 API 설정을 완료한 후 다시 시도하세요.", "请在提供商账户中完成 API 设置，然后重试。", "أكمل إعداد الواجهة في حساب المزوّد ثم أعد المحاولة."),
  service_unavailable: row("The provider is temporarily unavailable. Retry shortly.", "O provedor está temporariamente indisponível. Tente em instantes.", "El proveedor no está disponible temporalmente. Reintenta pronto.", "Le fournisseur est temporairement indisponible. Réessayez bientôt.", "Der Anbieter ist vorübergehend nicht verfügbar. Gleich erneut versuchen.", "Il fornitore è temporaneamente indisponibile. Riprova tra poco.", "プロバイダーは一時的に利用できません。少し待って再試行してください。", "공급자를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도하세요.", "提供商暂时不可用。请稍后重试。", "المزوّد غير متاح مؤقتًا. أعد المحاولة بعد قليل."),
  rate_limited: row("The provider’s request limit was reached. Wait and retry.", "O limite de pedidos do provedor foi atingido. Aguarde e tente novamente.", "Se alcanzó el límite de solicitudes del proveedor. Espera y reintenta.", "La limite de requêtes du fournisseur est atteinte. Patientez puis réessayez.", "Anfragelimit des Anbieters erreicht. Warten und erneut versuchen.", "Limite di richieste del fornitore raggiunto. Attendi e riprova.", "プロバイダーのリクエスト上限に達しました。待って再試行してください。", "공급자의 요청 한도에 도달했습니다. 기다린 후 다시 시도하세요.", "已达到提供商的请求限制。请稍后重试。", "تم بلوغ حد طلبات المزوّد. انتظر ثم أعد المحاولة."),
  catalog_declared: row("Catalog models; account access is checked when used.", "Modelos do catálogo; acesso da conta verificado no uso.", "Modelos del catálogo; el acceso de la cuenta se comprueba al usarlos.", "Modèles du catalogue ; l’accès du compte sera vérifié à l’utilisation.", "Katalogmodelle; Kontozugriff wird bei Verwendung geprüft.", "Modelli del catalogo; accesso dell’account verificato all’uso.", "カタログのモデルです。アカウントの利用可否は使用時に確認します。", "카탈로그 모델입니다. 사용 시 계정 접근 권한을 확인합니다.", "目录模型；使用时检查账户访问权限。", "نماذج الفهرس؛ يُفحص وصول الحساب عند الاستخدام."),
  manual_model: row("Enter the model ID", "Informe o ID do modelo", "Introduce el ID del modelo", "Saisissez l’ID du modèle", "Modell-ID eingeben", "Inserisci l’ID del modello", "モデルIDを入力", "모델 ID 입력", "输入模型 ID", "أدخل معرّف النموذج"),
  manual_hint: row("This API has no model catalog. Use the exact ID from your API documentation.", "Esta API não tem catálogo. Use o ID exato da documentação da API.", "Esta API no tiene catálogo. Usa el ID exacto de su documentación.", "Cette API n’a pas de catalogue. Utilisez l’ID exact indiqué dans sa documentation.", "Diese API hat keinen Modellkatalog. Verwenden Sie die genaue ID aus ihrer Dokumentation.", "Questa API non ha un catalogo. Usa l’ID esatto della documentazione.", "このAPIにはモデル一覧がありません。APIの文書にある正確なIDを入力してください。", "이 API에는 모델 목록이 없습니다. API 문서의 정확한 ID를 입력하세요.", "此 API 没有模型目录。请使用 API 文档中的准确 ID。", "لا تملك هذه الواجهة فهرس نماذج. استخدم المعرّف الدقيق من وثائق الواجهة."),
  manual_declared: row("Model entered by you; availability is checked when used.", "Modelo informado por você; disponibilidade verificada no uso.", "Modelo indicado por ti; se comprobará su disponibilidad al usarlo.", "Modèle saisi par vous ; sa disponibilité sera vérifiée à l’utilisation.", "Von Ihnen angegebenes Modell; Verfügbarkeit wird bei Verwendung geprüft.", "Modello indicato da te; disponibilità verificata all’uso.", "入力されたモデルです。利用時に利用可能か確認します。", "직접 입력한 모델입니다. 사용할 때 가용성을 확인합니다.", "这是您输入的模型；使用时会检查可用性。", "نموذج أدخلته أنت؛ يُفحَص توفره عند الاستخدام."),
  model_invalid: row("Use the exact model ID, without spaces or credentials.", "Use o ID exato do modelo, sem espaços nem credenciais.", "Usa el ID exacto, sin espacios ni credenciales.", "Utilisez l’ID exact, sans espaces ni identifiants secrets.", "Verwenden Sie die genaue Modell-ID ohne Leerzeichen oder Zugangsdaten.", "Usa l’ID esatto, senza spazi né credenziali.", "空白や認証情報を含めず、正確なモデルIDを入力してください。", "공백이나 인증 정보 없이 정확한 모델 ID를 입력하세요.", "请输入准确的模型 ID，不含空格或凭据。", "استخدم المعرّف الدقيق للنموذج دون مسافات أو بيانات اعتماد."),
  attachment_unavailable: row("This input cannot be sent through the selected connection. Remove it and choose a supported input or paste its text. Your request is kept.", "Esta entrada não pode ser enviada pela conexão selecionada. Remova-a e escolha uma entrada compatível ou cole seu texto. Seu pedido foi mantido.", "Esta entrada no se puede enviar por la conexión elegida. Elimínala y elige una entrada compatible o pega su texto. Tu solicitud se conserva.", "Cette entrée ne peut pas être envoyée par la connexion choisie. Retirez-la et choisissez une entrée prise en charge ou collez son texte. Votre demande est conservée.", "Diese Eingabe kann über die gewählte Verbindung nicht gesendet werden. Entfernen Sie sie und wählen Sie eine unterstützte Eingabe oder fügen Sie ihren Text ein. Ihre Anfrage bleibt erhalten.", "Questo input non può essere inviato tramite la connessione scelta. Rimuovilo e scegli un input supportato o incolla il testo. La richiesta viene conservata.", "この入力は選択した接続で送信できません。削除して対応する入力を選ぶか、テキストを貼り付けてください。リクエストは保持されます。", "선택한 연결로 이 입력을 보낼 수 없습니다. 삭제하고 지원되는 입력을 선택하거나 텍스트를 붙여 넣으세요. 요청은 보존됩니다.", "无法通过所选连接发送此输入。请移除它并选择受支持的输入，或粘贴其文本。您的请求已保留。", "لا يمكن إرسال هذا الإدخال عبر الاتصال المحدد. أزله واختر إدخالًا مدعومًا أو الصق نصه. تم الاحتفاظ بطلبك."),
  attachment_project: row("Choose a project folder, then attach a file inside it. Your request is kept.", "Escolha a pasta do projeto e anexe um arquivo dentro dela. Seu pedido foi mantido.", "Elige la carpeta del proyecto y adjunta un archivo dentro de ella. Tu solicitud se conserva.", "Choisissez le dossier du projet puis joignez un fichier qu’il contient. Votre demande est conservée.", "Wählen Sie den Projektordner und hängen Sie eine Datei darin an. Ihre Anfrage bleibt erhalten.", "Scegli la cartella del progetto e allega un file al suo interno. La richiesta viene conservata.", "プロジェクトフォルダーを選び、その中のファイルを添付してください。リクエストは保持されます。", "프로젝트 폴더를 선택한 다음 그 안의 파일을 첨부하세요. 요청은 보존됩니다.", "请选择项目文件夹，然后附加其中的文件。您的请求已保留。", "اختر مجلد المشروع ثم أرفق ملفًا بداخله. تم الاحتفاظ بطلبك."),
  attachment_read: row("The selected file could not be read. Check its location and project access, then attach it again. Your request is kept.", "Não foi possível ler o arquivo. Confira o caminho e o acesso ao projeto e anexe-o novamente. Seu pedido foi mantido.", "No se pudo leer el archivo. Comprueba su ubicación y el acceso al proyecto y adjúntalo de nuevo. Tu solicitud se conserva.", "Le fichier n’a pas pu être lu. Vérifiez son emplacement et l’accès au projet, puis joignez-le à nouveau. Votre demande est conservée.", "Die Datei konnte nicht gelesen werden. Prüfen Sie ihren Speicherort und den Projektzugriff und hängen Sie sie erneut an. Ihre Anfrage bleibt erhalten.", "Impossibile leggere il file. Controlla il percorso e l’accesso al progetto, poi allegalo di nuovo. La richiesta viene conservata.", "ファイルを読み取れませんでした。場所とプロジェクトへのアクセスを確認し、再度添付してください。リクエストは保持されます。", "파일을 읽을 수 없습니다. 위치와 프로젝트 접근 권한을 확인한 다음 다시 첨부하세요. 요청은 보존됩니다.", "无法读取所选文件。请检查位置和项目访问权限，再次附加。您的请求已保留。", "تعذّرت قراءة الملف المحدد. تحقق من موقعه ومن صلاحية الوصول إلى المشروع ثم أرفقه مجددًا. تم الاحتفاظ بطلبك."),
  attachment_changed: row("The project or conversation changed while preparing the files. Attach them again in the current conversation. Your request is kept.", "O projeto ou a conversa mudou durante a preparação dos arquivos. Anexe-os novamente na conversa atual. Seu pedido foi mantido.", "El proyecto o la conversación cambió al preparar los archivos. Adjunta los archivos de nuevo en la conversación actual. Tu solicitud se conserva.", "Le projet ou la conversation a changé pendant la préparation des fichiers. Joignez-les à nouveau dans la conversation actuelle. Votre demande est conservée.", "Projekt oder Unterhaltung wurde beim Vorbereiten der Dateien geändert. Hängen Sie sie in der aktuellen Unterhaltung erneut an. Ihre Anfrage bleibt erhalten.", "Il progetto o la conversazione è cambiato durante la preparazione dei file. Allegali di nuovo nella conversazione attuale. La richiesta viene conservata.", "ファイルの準備中にプロジェクトまたは会話が変わりました。現在の会話で再度添付してください。リクエストは保持されます。", "파일 준비 중 프로젝트나 대화가 변경되었습니다. 현재 대화에 다시 첨부하세요. 요청은 보존됩니다.", "准备文件时项目或对话已改变。请在当前对话中再次附加。您的请求已保留。", "تغيّر المشروع أو المحادثة أثناء إعداد الملفات. أرفقها مجددًا في المحادثة الحالية. تم الاحتفاظ بطلبك."),
  attachment_busy: row("Wait for the current response before sending files. Your request is kept.", "Aguarde a resposta atual antes de enviar arquivos. Seu pedido foi mantido.", "Espera a que termine la respuesta actual antes de enviar archivos. Tu solicitud se conserva.", "Attendez la fin de la réponse actuelle avant d’envoyer des fichiers. Votre demande est conservée.", "Warten Sie auf die aktuelle Antwort, bevor Sie Dateien senden. Ihre Anfrage bleibt erhalten.", "Attendi la risposta attuale prima di inviare file. La richiesta viene conservata.", "現在の応答が終わるまでファイルの送信をお待ちください。リクエストは保持されます。", "파일을 보내기 전에 현재 응답이 끝날 때까지 기다리세요. 요청은 보존됩니다.", "请等待当前回复完成后再发送文件。您的请求已保留。", "انتظر انتهاء الرد الحالي قبل إرسال الملفات. تم الاحتفاظ بطلبك."),
  attachment_size: row("The files exceed the input limit. Attach a smaller file or reduce the context, then try again. Your request is kept.", "Os arquivos ultrapassam o limite de entrada. Anexe um arquivo menor ou reduza o contexto e tente novamente. Seu pedido foi mantido.", "Los archivos superan el límite de entrada. Adjunta un archivo menor o reduce el contexto y reintenta. Tu solicitud se conserva.", "Les fichiers dépassent la limite d’entrée. Joignez un fichier plus petit ou réduisez le contexte, puis réessayez. Votre demande est conservée.", "Die Dateien überschreiten die Eingabegrenze. Hängen Sie eine kleinere Datei an oder reduzieren Sie den Kontext und versuchen Sie es erneut. Ihre Anfrage bleibt erhalten.", "I file superano il limite di input. Allega un file più piccolo o riduci il contesto e riprova. La richiesta viene conservata.", "ファイルが入力制限を超えています。小さいファイルを添付するかコンテキストを減らして再試行してください。リクエストは保持されます。", "파일이 입력 한도를 초과합니다. 더 작은 파일을 첨부하거나 컨텍스트를 줄이고 다시 시도하세요. 요청은 보존됩니다.", "文件超出输入限制。请附加较小的文件或减少上下文，然后重试。您的请求已保留。", "تتجاوز الملفات حد الإدخال. أرفق ملفًا أصغر أو قلّل السياق ثم أعد المحاولة. تم الاحتفاظ بطلبك."),
  attachment_temporary: row("File attachments need local storage. Choose local storage for this conversation or paste text to continue temporarily. Your request is kept.", "Anexos precisam de armazenamento local. Escolha armazenamento local nesta conversa ou cole o texto para continuar temporariamente. Seu pedido foi mantido.", "Los archivos adjuntos requieren almacenamiento local. Elige almacenamiento local para esta conversación o pega texto para continuar temporalmente. Tu solicitud se conserva.", "Les pièces jointes nécessitent un stockage local. Choisissez le stockage local pour cette conversation ou collez du texte pour continuer temporairement. Votre demande est conservée.", "Dateianhänge benötigen lokalen Speicher. Wählen Sie lokalen Speicher für diese Unterhaltung oder fügen Sie Text ein, um temporär fortzufahren. Ihre Anfrage bleibt erhalten.", "Gli allegati richiedono archiviazione locale. Sceglila per questa conversazione o incolla testo per continuare temporaneamente. La richiesta viene conservata.", "添付ファイルにはローカル保存が必要です。この会話でローカル保存を選ぶか、テキストを貼り付けて一時モードで続行してください。リクエストは保持されます。", "파일 첨부에는 로컬 저장이 필요합니다. 이 대화에서 로컬 저장을 선택하거나 텍스트를 붙여 넣어 임시 모드로 계속하세요. 요청은 보존됩니다.", "附件需要本地存储。请为此对话选择本地存储，或粘贴文本以继续临时模式。您的请求已保留。", "تحتاج المرفقات إلى تخزين محلي. اختره لهذه المحادثة أو الصق نصًا للاستمرار مؤقتًا. تم الاحتفاظ بطلبك."),
  details: row("Details", "Detalhes", "Detalles", "Détails", "Details", "Dettagli", "詳細", "세부 정보", "详情", "التفاصيل"),
  refresh: row("Refresh", "Atualizar", "Actualizar", "Actualiser", "Aktualisieren", "Aggiorna", "更新", "새로 고침", "刷新", "تحديث"),
  loading: row("Checking…", "Verificando…", "Comprobando…", "Vérification…", "Wird geprüft…", "Verifica…", "確認中…", "확인 중…", "检查中…", "جارٍ التحقق…"),
  unavailable: row("Unavailable. Refresh to try again.", "Indisponível. Atualize para tentar novamente.", "No disponible. Actualiza para reintentar.", "Indisponible. Actualisez pour réessayer.", "Nicht verfügbar. Aktualisieren Sie für einen erneuten Versuch.", "Non disponibile. Aggiorna per riprovare.", "利用できません。更新して再試行してください。", "사용할 수 없습니다. 새로 고침으로 다시 시도하세요.", "不可用。请刷新重试。", "غير متاح. حدّث للمحاولة مجددًا."),
  usage_scope: row("Provider-reported usage since the core started; responses without usage and gateway dispatches are excluded. This is not an account balance or quota.", "Uso informado pelos provedores desde o início do núcleo; respostas sem uso e envios pelo gateway não entram. Não é saldo nem cota da conta.", "Uso declarado por los proveedores desde el inicio del núcleo; se excluyen respuestas sin uso y envíos por gateway. No es saldo ni cuota de la cuenta.", "Usage déclaré par les fournisseurs depuis le démarrage du cœur ; les réponses sans usage et les envois via la passerelle sont exclus. Ce n’est pas le solde ou le quota du compte.", "Von Anbietern gemeldete Nutzung seit dem Start des Kerns; Antworten ohne Nutzungsdaten und Gateway-Anfragen sind ausgeschlossen. Dies ist kein Kontostand oder Kontingent.", "Utilizzo dichiarato dai provider dall’avvio del nucleo; escluse risposte senza dati d’uso e invii tramite gateway. Non è saldo o quota dell’account.", "コア起動後にプロバイダーが報告した使用量です。使用量の報告がない応答とゲートウェイ経由の送信は除外されます。アカウントの残高や上限ではありません。", "코어 시작 이후 제공업체가 보고한 사용량입니다. 사용량 미보고 응답과 게이트웨이 전송은 제외됩니다. 계정 잔액이나 할당량이 아닙니다.", "这是核心启动后提供商报告的用量；不含未报告用量的回复和网关发送。此数据不是账户余额或配额。", "الاستخدام الذي أبلغ عنه المزوّدون منذ بدء النواة؛ تُستبعد الردود دون بيانات استخدام والإرسال عبر البوابة. هذا ليس رصيد الحساب أو حصته."),
  usage_total: row("Reported tokens: {tokens}", "Tokens informados: {tokens}", "Tokens declarados: {tokens}", "Jetons déclarés : {tokens}", "Gemeldete Tokens: {tokens}", "Token dichiarati: {tokens}", "報告されたトークン: {tokens}", "보고된 토큰: {tokens}", "已报告的令牌：{tokens}", "الرموز المُبلَّغ عنها: {tokens}"),
  usage_provider: row("Input {input} · Output {output} · Reported {reported} · Unreported {unreported} · Interrupted {interrupted} · Active {active}", "Entrada {input} · Saída {output} · Informadas {reported} · Sem dados {unreported} · Interrompidas {interrupted} · Ativas {active}", "Entrada {input} · Salida {output} · Declaradas {reported} · Sin datos {unreported} · Interrumpidas {interrupted} · Activas {active}", "Entrée {input} · Sortie {output} · Déclarées {reported} · Sans données {unreported} · Interrompues {interrupted} · Actives {active}", "Eingabe {input} · Ausgabe {output} · Gemeldet {reported} · Ohne Daten {unreported} · Unterbrochen {interrupted} · Aktiv {active}", "Input {input} · Output {output} · Dichiarate {reported} · Senza dati {unreported} · Interrotte {interrupted} · Attive {active}", "入力 {input} · 出力 {output} · 報告あり {reported} · 報告なし {unreported} · 中断 {interrupted} · 実行中 {active}", "입력 {input} · 출력 {output} · 보고됨 {reported} · 미보고 {unreported} · 중단 {interrupted} · 진행 중 {active}", "输入 {input} · 输出 {output} · 已报告 {reported} · 未报告 {unreported} · 已中断 {interrupted} · 进行中 {active}", "إدخال {input} · إخراج {output} · مُبلّغ {reported} · غير مُبلّغ {unreported} · متوقف {interrupted} · نشط {active}"),
  ready: row("Connected and ready", "Conectado e pronto", "Conectado y listo", "Connecté et prêt", "Verbunden und bereit", "Connesso e pronto", "接続済み、準備完了", "연결되어 준비됨", "已连接并就绪", "متصل وجاهز"),
  attention: row("Connection needs attention. Check the connection and retry.", "A conexão precisa de atenção. Confira a conexão e tente novamente.", "La conexión necesita atención. Compruébala y reintenta.", "La connexion demande votre attention. Vérifiez-la et réessayez.", "Die Verbindung erfordert Aufmerksamkeit. Prüfen Sie sie und versuchen Sie es erneut.", "La connessione richiede attenzione. Controllala e riprova.", "接続を確認し、再試行してください。", "연결을 확인한 다음 다시 시도하세요.", "连接需要处理。请检查连接后重试。", "الاتصال يحتاج إلى عناية. تحقق منه وأعد المحاولة."),
  core: row("Core: {version} · {url}", "Núcleo: {version} · {url}", "Núcleo: {version} · {url}", "Cœur : {version} · {url}", "Kern: {version} · {url}", "Nucleo: {version} · {url}", "コア: {version} · {url}", "코어: {version} · {url}", "核心：{version} · {url}", "النواة: {version} · {url}"),
  host: row("Host: {platform} · {arch} · {release}", "Sistema: {platform} · {arch} · {release}", "Sistema: {platform} · {arch} · {release}", "Système : {platform} · {arch} · {release}", "System: {platform} · {arch} · {release}", "Sistema: {platform} · {arch} · {release}", "ホスト: {platform} · {arch} · {release}", "호스트: {platform} · {arch} · {release}", "主机：{platform} · {arch} · {release}", "المضيف: {platform} · {arch} · {release}"),
  runtime: row("Terminal runtime: {runtime}", "Runtime do terminal: {runtime}", "Runtime del terminal: {runtime}", "Runtime du terminal : {runtime}", "Terminal-Laufzeit: {runtime}", "Runtime del terminale: {runtime}", "端末ランタイム: {runtime}", "터미널 런타임: {runtime}", "终端运行时：{runtime}", "بيئة تشغيل الطرفية: {runtime}"),
} as const

export function connectionText(key: keyof typeof CONNECTION_STRINGS, params: Record<string, string | number> = {}, lang = getLang()): string {
  return CONNECTION_STRINGS[key][lang].replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

export function setupErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : ""
  const classified: Record<string, keyof typeof CONNECTION_STRINGS> = {
    provider_region_or_key_rejected: 'region_or_key',
    provider_access_denied: 'access_denied', provider_key_restricted: 'key_restricted',
    provider_service_disabled: 'service_disabled', provider_billing_required: 'billing_required',
    provider_setup_required: 'setup_required', provider_service_unavailable: 'service_unavailable',
    provider_discovery_rate_limited: 'rate_limited',
  }
  if (classified[code]) return connectionText(classified[code])
  if (/401|403|auth|key_invalid|key_rejected/.test(code)) return ui("connect_key_rejected")
  if (/discovery_unsupported/.test(code)) return ui("connect_no_catalog")
  if (/model_limit/.test(code)) return ui("connect_model_limit")
  if (/empty|no_models/.test(code)) return ui("connect_models_empty")
  if (/timeout/.test(code)) return ui("connect_timeout")
  if (/reload/.test(code)) return ui("connect_reload_failed")
  if (/vault|secret_store/.test(code)) return ui("connect_vault_failed")
  if (/endpoint|url/.test(code)) return ui("connect_url_invalid")
  return ui("connect_network")
}

/** Error routing only uses known service codes; provider responses/credentials are never shown or logged. */
export function setupRecovery(error: unknown): "key" | "manual" | "model" | "endpoint" | "stop" {
  const code = error instanceof Error ? error.message : ""
  if (["provider_key_required", "provider_key_rejected", "provider_key_invalid"].includes(code)) return "key"
  if (["provider_discovery_unsupported", "provider_models_empty", "provider_models_invalid"].includes(code)) return "manual"
  if (["provider_model_invalid", "provider_credential_in_metadata"].includes(code)) return "model"
  if (code === "provider_endpoint_required") return "endpoint"
  return "stop"
}

export interface UsageRow {
  provider: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  responsesWithUsage: number
  responsesWithoutUsage: number
  interruptedResponses: number
  responsesInFlight: number
}

/** Only recognize the published local meter shape. Missing metrics never become zero usage or quota. */
export function readUsageRows(value: Record<string, unknown>): UsageRow[] | null {
  if (value.basis !== "provider_reported" || value.scope !== "successful_router_responses_this_process"
    || value.tokenTotals !== "reported_subset_only" || !Array.isArray(value.providers)) return null
  const keys = ["inputTokens", "outputTokens", "totalTokens", "responsesWithUsage", "responsesWithoutUsage", "interruptedResponses", "responsesInFlight"] as const
  const rows: UsageRow[] = []
  for (const raw of value.providers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    if (typeof item.provider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(item.provider)
      || keys.some((key) => typeof item[key] !== "number" || !Number.isSafeInteger(item[key]) || (item[key] as number) < 0)) return null
    rows.push(item as unknown as UsageRow)
  }
  return rows
}

export async function prepareConnection(input: {
  service: ProviderSetupService
  choice: { id: string; local: boolean; configured: boolean }
  endpoint?: string
  requestKey(error?: unknown): Promise<string | null>
  requestModel(error?: unknown): Promise<string | null>
  requestEndpoint(): Promise<string | null>
  busy(): void
}): Promise<PreparedProviderSetup | null> {
  let key: string | undefined
  let endpoint = input.endpoint
  let model: string | undefined
  let keyError: unknown
  let needsKey = !input.choice.local && !input.choice.configured
  for (;;) {
    if (needsKey) {
      const entered = await input.requestKey(keyError)
      if (entered === null) return null
      key = entered
      needsKey = false
    }
    input.busy()
    try {
      return model === undefined
        ? await input.service.prepare(input.choice.id, key, endpoint)
        : await input.service.prepareManual(input.choice.id, key, endpoint, model)
    } catch (error) {
      const recovery = setupRecovery(error)
      if (recovery === "key") { key = undefined; keyError = error; needsKey = true; continue }
      if (recovery === "manual" || recovery === "model") {
        const entered = await input.requestModel(recovery === "model" ? error : undefined)
        if (entered === null) return null
        model = entered.trim()
        continue
      }
      if (recovery === "endpoint") {
        const entered = await input.requestEndpoint()
        if (entered === null) return null
        endpoint = entered.trim()
        continue
      }
      throw error
    }
  }
}
