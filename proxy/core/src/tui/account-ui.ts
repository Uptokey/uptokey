import { getLang, type Lang } from "./i18n.ts";

const LANGS: readonly Lang[] = ["pt-BR", "en", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"];
type Ten = readonly [string, string, string, string, string, string, string, string, string, string];
export const ACCOUNT_TEXT = {
  title: ["Conta Uptokey", "Uptokey account", "Cuenta Uptokey", "Compte Uptokey", "Uptokey-Konto", "Account Uptokey", "Uptokey アカウント", "Uptokey 계정", "Uptokey 账户", "حساب Uptokey"],
  signed_out: ["Desconectado", "Signed out", "Sesión cerrada", "Déconnecté", "Abgemeldet", "Disconnesso", "未ログイン", "로그아웃 상태", "未登录", "غير مسجّل الدخول"],
  connected: ["Conectado", "Connected", "Conectado", "Connecté", "Verbunden", "Connesso", "接続済み", "연결됨", "已连接", "متصل"],
  sign_in: ["Entrar", "Sign in", "Iniciar sesión", "Se connecter", "Anmelden", "Accedi", "ログイン", "로그인", "登录", "تسجيل الدخول"],
  share: ["Usar a conta deste computador", "Use account on this computer", "Usar la cuenta de este ordenador", "Utiliser le compte de cet ordinateur", "Konto auf diesem Computer verwenden", "Usa l'account su questo computer", "このコンピューターのアカウントを使う", "이 컴퓨터의 계정 사용", "使用此电脑上的账户", "استخدام الحساب على هذا الكمبيوتر"],
  use: ["Usar {name}", "Use {name}", "Usar {name}", "Utiliser {name}", "{name} verwenden", "Usa {name}", "{name} を使う", "{name} 사용", "使用 {name}", "استخدام {name}"],
  waiting: ["Autorize o código {code} na conta já conectada.", "Approve code {code} in the account already signed in.", "Autoriza el código {code} en la cuenta ya conectada.", "Autorisez le code {code} dans le compte déjà connecté.", "Code {code} im bereits angemeldeten Konto genehmigen.", "Autorizza il codice {code} nell'account già connesso.", "ログイン済みのアカウントでコード {code} を承認してください。", "이미 로그인한 계정에서 코드 {code}를 승인하세요.", "请在已登录的账户中批准代码 {code}。", "وافق على الرمز {code} في الحساب المسجّل بالفعل."],
  browser: ["Conclua o acesso no navegador · {code}", "Complete sign-in in your browser · {code}", "Completa el acceso en el navegador · {code}", "Terminez la connexion dans le navigateur · {code}", "Anmeldung im Browser abschließen · {code}", "Completa l'accesso nel browser · {code}", "ブラウザーでログインを完了 · {code}", "브라우저에서 로그인 완료 · {code}", "在浏览器中完成登录 · {code}", "أكمل تسجيل الدخول في المتصفح · {code}"],
  approve: ["Autorizar {name} · {code}", "Approve {name} · {code}", "Autorizar {name} · {code}", "Autoriser {name} · {code}", "{name} genehmigen · {code}", "Autorizza {name} · {code}", "{name} を承認 · {code}", "{name} 승인 · {code}", "批准 {name} · {code}", "السماح لـ {name} · {code}"],
  consent: ["Permitir que este cliente use sua conta Uptokey? Pastas não são autorizadas.", "Allow this client to use your Uptokey account? Folder access is not granted.", "¿Permitir que este cliente use tu cuenta Uptokey? No autoriza carpetas.", "Autoriser ce client à utiliser votre compte Uptokey ? Aucun accès aux dossiers n'est accordé.", "Diesem Client die Nutzung Ihres Uptokey-Kontos erlauben? Kein Ordnerzugriff wird gewährt.", "Consentire a questo client di usare il tuo account Uptokey? Non autorizza l'accesso alle cartelle.", "このクライアントに Uptokey アカウントの利用を許可しますか？フォルダーへのアクセスは許可されません。", "이 클라이언트가 Uptokey 계정을 사용하도록 허용할까요? 폴더 접근은 허용되지 않습니다.", "允许此客户端使用您的 Uptokey 账户吗？不会授予文件夹访问权限。", "هل تسمح لهذا العميل باستخدام حساب Uptokey؟ لا يمنح هذا الوصول إلى المجلدات."],
  allow: ["Permitir", "Allow", "Permitir", "Autoriser", "Erlauben", "Consenti", "許可", "허용", "允许", "السماح"],
  cancel: ["Cancelar", "Cancel", "Cancelar", "Annuler", "Abbrechen", "Annulla", "キャンセル", "취소", "取消", "إلغاء"],
  refresh: ["Atualizar", "Refresh", "Actualizar", "Actualiser", "Aktualisieren", "Aggiorna", "更新", "새로고침", "刷新", "تحديث"],
  disconnect: ["Desconectar este cliente", "Disconnect this client", "Desconectar este cliente", "Déconnecter ce client", "Diesen Client trennen", "Disconnetti questo client", "このクライアントを切断", "이 클라이언트 연결 해제", "断开此客户端", "فصل هذا العميل"],
  sign_out: ["Sair da conta", "Sign out", "Cerrar sesión", "Se déconnecter", "Abmelden", "Esci", "ログアウト", "로그아웃", "退出登录", "تسجيل الخروج"],
  usage: ["Créditos Uptokey", "Uptokey credits", "Créditos Uptokey", "Crédits Uptokey", "Uptokey-Guthaben", "Crediti Uptokey", "Uptokey クレジット", "Uptokey 크레딧", "Uptokey 额度", "رصيد Uptokey"],
  balance: ["Disponível: {value}", "Available: {value}", "Disponible: {value}", "Disponible : {value}", "Verfügbar: {value}", "Disponibile: {value}", "利用可能: {value}", "사용 가능: {value}", "可用：{value}", "المتاح: {value}"],
  usage_unavailable: ["Saldo ainda não disponível", "Balance not available yet", "Saldo aún no disponible", "Solde pas encore disponible", "Guthaben noch nicht verfügbar", "Saldo non ancora disponibile", "残高はまだ取得できません", "잔액을 아직 사용할 수 없음", "余额暂不可用", "الرصيد غير متاح بعد"],
  loading: ["Carregando…", "Loading…", "Cargando…", "Chargement…", "Wird geladen…", "Caricamento…", "読み込み中…", "불러오는 중…", "加载中…", "جارٍ التحميل…"],
  retry: ["Não foi possível acessar a conta. Tente novamente.", "Could not reach the account. Try again.", "No se pudo acceder a la cuenta. Inténtalo de nuevo.", "Impossible d'accéder au compte. Réessayez.", "Konto nicht erreichbar. Erneut versuchen.", "Impossibile accedere all'account. Riprova.", "アカウントに接続できません。再試行してください。", "계정에 접근할 수 없습니다. 다시 시도하세요.", "无法访问账户，请重试。", "تعذّر الوصول إلى الحساب. حاول مجددًا."],
  expired: ["A autorização expirou. Inicie novamente.", "Authorization expired. Start again.", "La autorización caducó. Inicia de nuevo.", "L'autorisation a expiré. Recommencez.", "Genehmigung abgelaufen. Erneut starten.", "Autorizzazione scaduta. Ricomincia.", "承認の有効期限が切れました。やり直してください。", "승인이 만료되었습니다. 다시 시작하세요.", "授权已过期，请重新开始。", "انتهت صلاحية التفويض. ابدأ مجددًا."],
  changed: ["A conta mudou. Atualize antes de continuar.", "The account changed. Refresh before continuing.", "La cuenta cambió. Actualiza antes de continuar.", "Le compte a changé. Actualisez avant de continuer.", "Das Konto hat sich geändert. Vor dem Fortfahren aktualisieren.", "L'account è cambiato. Aggiorna prima di continuare.", "アカウントが変更されました。更新してから続行してください。", "계정이 변경되었습니다. 계속하기 전에 새로고침하세요.", "账户已更改，请刷新后继续。", "تغيّر الحساب. حدّث قبل المتابعة."],
  unavailable: ["O acesso à conta ainda não está disponível neste serviço.", "Account sign-in is not available on this service yet.", "El acceso a la cuenta aún no está disponible en este servicio.", "La connexion au compte n'est pas encore disponible sur ce service.", "Kontoanmeldung ist in diesem Dienst noch nicht verfügbar.", "L'accesso all'account non è ancora disponibile su questo servizio.", "このサービスではアカウントのログインがまだ利用できません。", "이 서비스에서 계정 로그인을 아직 사용할 수 없습니다.", "此服务暂不支持账户登录。", "تسجيل الدخول إلى الحساب غير متاح في هذه الخدمة بعد."],
  details: ["Detalhes técnicos", "Technical details", "Detalles técnicos", "Détails techniques", "Technische Details", "Dettagli tecnici", "技術的な詳細", "기술 세부 정보", "技术详情", "تفاصيل تقنية"],
  free: ["Gratuito", "Free", "Gratis", "Gratuit", "Kostenlos", "Gratuito", "無料", "무료", "免费", "مجاني"],
  individual: ["Individual", "Individual", "Individual", "Individuel", "Einzelperson", "Individuale", "個人", "개인", "个人", "فردي"],
  team: ["Equipe", "Team", "Equipo", "Équipe", "Team", "Team", "チーム", "팀", "团队", "فريق"],
  enterprise: ["Empresa", "Enterprise", "Empresa", "Entreprise", "Unternehmen", "Impresa", "企業", "기업", "企业", "مؤسسة"],
} satisfies Record<string, Ten>;
export type AccountTextKey = keyof typeof ACCOUNT_TEXT;
export function accountText(key: AccountTextKey, params: Record<string, string> = {}, lang: Lang = getLang()): string {
  return ACCOUNT_TEXT[key][LANGS.indexOf(lang)]!.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match);
}
export function accountErrorText(code: string): string {
  if (code.includes("expired")) return accountText("expired");
  if (code.includes("conflict") || code.includes("stale")) return accountText("changed");
  if (code === "account_service_not_configured") return accountText("unavailable");
  return accountText("retry");
}
