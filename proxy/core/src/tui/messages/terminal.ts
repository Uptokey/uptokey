import type { Lang } from '../i18n.ts';

const HELP: Record<Lang, readonly string[]> = {
  en: ['Uptokey — coding in your terminal', 'Usage: uptokey [folder] [options]', 'Project folder', 'Initial model', 'Connect a provider', 'Interface language', 'Resume a conversation', 'Accessible linear display', 'Autonomous coding', 'Temporary conversation', 'Allow configured external providers', 'Non-interactive JSONL', 'Local service port', 'Theme', 'Help', 'Version'],
  'pt-BR': ['Uptokey — programação no terminal', 'Uso: uptokey [pasta] [opções]', 'Pasta do projeto', 'Modelo inicial', 'Conectar provedor', 'Idioma da interface', 'Retomar conversa', 'Exibição linear acessível', 'Programação autônoma', 'Conversa temporária', 'Permitir provedores externos configurados', 'JSONL não interativo', 'Porta do serviço local', 'Tema', 'Ajuda', 'Versão'],
  es: ['Uptokey — programación en tu terminal', 'Uso: uptokey [carpeta] [opciones]', 'Carpeta del proyecto', 'Modelo inicial', 'Conectar proveedor', 'Idioma de la interfaz', 'Retomar conversación', 'Vista lineal accesible', 'Programación autónoma', 'Conversación temporal', 'Permitir proveedores externos configurados', 'JSONL no interactivo', 'Puerto del servicio local', 'Tema', 'Ayuda', 'Versión'],
  fr: ['Uptokey — programmation dans votre terminal', 'Utilisation : uptokey [dossier] [options]', 'Dossier du projet', 'Modèle initial', 'Connecter un fournisseur', 'Langue de l’interface', 'Reprendre une conversation', 'Affichage linéaire accessible', 'Programmation autonome', 'Conversation temporaire', 'Autoriser les fournisseurs externes configurés', 'JSONL non interactif', 'Port du service local', 'Thème', 'Aide', 'Version'],
  de: ['Uptokey — Programmieren im Terminal', 'Verwendung: uptokey [Ordner] [Optionen]', 'Projektordner', 'Anfangsmodell', 'Anbieter verbinden', 'Sprache der Oberfläche', 'Unterhaltung fortsetzen', 'Barrierefreie lineare Ansicht', 'Autonomes Programmieren', 'Temporäre Unterhaltung', 'Konfigurierte externe Anbieter erlauben', 'Nicht interaktives JSONL', 'Port des lokalen Dienstes', 'Design', 'Hilfe', 'Version'],
  it: ['Uptokey — programmazione nel terminale', 'Uso: uptokey [cartella] [opzioni]', 'Cartella del progetto', 'Modello iniziale', 'Collega un provider', 'Lingua dell’interfaccia', 'Riprendi conversazione', 'Vista lineare accessibile', 'Programmazione autonoma', 'Conversazione temporanea', 'Consenti provider esterni configurati', 'JSONL non interattivo', 'Porta del servizio locale', 'Tema', 'Aiuto', 'Versione'],
  ja: ['Uptokey — ターミナルでプログラミング', '使い方: uptokey [フォルダー] [オプション]', 'プロジェクトフォルダー', '初期モデル', 'プロバイダーに接続', '画面の言語', '会話を再開', 'アクセシブルな線形表示', '自律的なプログラミング', '一時的な会話', '設定済みの外部プロバイダーを許可', '非対話型 JSONL', 'ローカルサービスのポート', 'テーマ', 'ヘルプ', 'バージョン'],
  ko: ['Uptokey — 터미널에서 코딩', '사용법: uptokey [폴더] [옵션]', '프로젝트 폴더', '초기 모델', '제공업체 연결', '인터페이스 언어', '대화 재개', '접근 가능한 선형 화면', '자율 코딩', '임시 대화', '설정된 외부 제공업체 허용', '비대화형 JSONL', '로컬 서비스 포트', '테마', '도움말', '버전'],
  'zh-CN': ['Uptokey — 在终端中编程', '用法：uptokey [文件夹] [选项]', '项目文件夹', '初始模型', '连接提供商', '界面语言', '恢复对话', '无障碍线性显示', '自主编程', '临时对话', '允许已配置的外部提供商', '非交互式 JSONL', '本地服务端口', '主题', '帮助', '版本'],
  ar: ['Uptokey — البرمجة في الطرفية', 'الاستخدام: uptokey [مجلد] [خيارات]', 'مجلد المشروع', 'النموذج الأولي', 'ربط مزوّد', 'لغة الواجهة', 'استئناف محادثة', 'عرض خطي ميسّر', 'برمجة مستقلة', 'محادثة مؤقتة', 'السماح بالمزوّدين الخارجيين المُعَدّين', 'JSONL غير تفاعلي', 'منفذ الخدمة المحلية', 'السمة', 'المساعدة', 'الإصدار'],
};

export function terminalHelp(lang: Lang): string {
  const rows = HELP[lang];
  const flags = ['--cwd <path>', '--model <id>', '--connect <provider>', '--lang <locale>', '--resume <id>', '--screen-reader', '--autonomy', '--temporary', '--external', '--pipe', '--port <number>', '--theme <name>', '-h, --help', '-v, --version'];
  return `\n${rows[0]}\n\n${rows[1]}\n\n${flags.map((flag, index) => `  ${flag.padEnd(23)} ${rows[index + 2]}`).join('\n')}\n\n`;
}
