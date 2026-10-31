/* Native-only local bridge controls. No credentials, discovery or background recovery. */
(() => {
  'use strict';
  if (location.origin !== 'http://127.0.0.1:43180' || location.pathname !== '/' || !window.__TAURI_INTERNALS__?.invoke) return;
  const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  const messages = {
    en: { title: 'Local connections', core: 'Core / local proxy', ollama: 'Ollama (optional)', unknown: 'Not checked', connected: 'Connected', unavailable: 'Unavailable', observed: 'Last attempt result; the current state may have changed.', unobserved: 'No connection check in this window yet.', scope: 'Reconnects existing local bridges. Computer pairing and context permissions are managed separately.', close: 'Close', reconnect: 'Reconnect', reconnecting: 'Reconnecting…', busy: 'Another local action is in progress. Try again when it finishes.', failed: 'Could not check the local bridges. Try again.' },
    'pt-BR': { title: 'Conexões locais', core: 'Core / proxy local', ollama: 'Ollama (opcional)', unknown: 'Não verificado', connected: 'Conectado', unavailable: 'Indisponível', observed: 'Resultado da última tentativa; o estado atual pode ter mudado.', unobserved: 'Nenhuma verificação de conexão nesta abertura.', scope: 'Reconecta as pontes locais existentes. O pareamento deste computador e as permissões de contexto são gerenciados separadamente.', close: 'Fechar', reconnect: 'Reconectar', reconnecting: 'Reconectando…', busy: 'Outra ação local está em andamento. Tente novamente ao concluir.', failed: 'Não foi possível verificar as pontes locais. Tente novamente.' },
    es: { title: 'Conexiones locales', core: 'Core / proxy local', ollama: 'Ollama (opcional)', unknown: 'Sin verificar', connected: 'Conectado', unavailable: 'No disponible', observed: 'Resultado del último intento; el estado actual puede haber cambiado.', unobserved: 'Todavía no se ha verificado la conexión en esta ventana.', scope: 'Reconecta los puentes locales existentes. El enlace de este equipo y los permisos de contexto se gestionan por separado.', close: 'Cerrar', reconnect: 'Reconectar', reconnecting: 'Reconectando…', busy: 'Hay otra acción local en curso. Inténtalo cuando termine.', failed: 'No se pudieron verificar los puentes locales. Inténtalo de nuevo.' },
    fr: { title: 'Connexions locales', core: 'Core / proxy local', ollama: 'Ollama (facultatif)', unknown: 'Non vérifié', connected: 'Connecté', unavailable: 'Indisponible', observed: 'Résultat de la dernière tentative ; l’état actuel peut avoir changé.', unobserved: 'Aucune vérification de connexion dans cette fenêtre.', scope: 'Reconnecte les ponts locaux existants. L’association de cet ordinateur et les autorisations de contexte sont gérées séparément.', close: 'Fermer', reconnect: 'Reconnecter', reconnecting: 'Reconnexion…', busy: 'Une autre action locale est en cours. Réessayez une fois terminée.', failed: 'Impossible de vérifier les ponts locaux. Réessayez.' },
    de: { title: 'Lokale Verbindungen', core: 'Core / lokaler Proxy', ollama: 'Ollama (optional)', unknown: 'Nicht geprüft', connected: 'Verbunden', unavailable: 'Nicht verfügbar', observed: 'Ergebnis des letzten Versuchs; der aktuelle Zustand kann sich geändert haben.', unobserved: 'In diesem Fenster wurde die Verbindung noch nicht geprüft.', scope: 'Verbindet bestehende lokale Brücken erneut. Computerkopplung und Kontextberechtigungen werden separat verwaltet.', close: 'Schließen', reconnect: 'Neu verbinden', reconnecting: 'Verbindung wird hergestellt…', busy: 'Eine andere lokale Aktion läuft. Versuchen Sie es nach deren Abschluss erneut.', failed: 'Die lokalen Brücken konnten nicht geprüft werden. Versuchen Sie es erneut.' },
    it: { title: 'Connessioni locali', core: 'Core / proxy locale', ollama: 'Ollama (facoltativo)', unknown: 'Non verificato', connected: 'Connesso', unavailable: 'Non disponibile', observed: 'Risultato dell’ultimo tentativo; lo stato attuale potrebbe essere cambiato.', unobserved: 'Nessuna verifica della connessione in questa finestra.', scope: 'Riconnette i ponti locali esistenti. L’associazione del computer e i permessi di contesto sono gestiti separatamente.', close: 'Chiudi', reconnect: 'Riconnetti', reconnecting: 'Riconnessione…', busy: 'È in corso un’altra azione locale. Riprova al termine.', failed: 'Impossibile verificare i ponti locali. Riprova.' },
    ja: { title: 'ローカル接続', core: 'Core / ローカルプロキシ', ollama: 'Ollama（任意）', unknown: '未確認', connected: '接続済み', unavailable: '利用不可', observed: '前回の試行結果です。現在の状態は変わっている可能性があります。', unobserved: 'このウィンドウではまだ接続を確認していません。', scope: '既存のローカルブリッジを再接続します。コンピューターのペアリングとコンテキストの権限は別に管理されます。', close: '閉じる', reconnect: '再接続', reconnecting: '再接続中…', busy: '別のローカル操作を実行中です。完了後に再試行してください。', failed: 'ローカルブリッジを確認できませんでした。再試行してください。' },
    ko: { title: '로컬 연결', core: 'Core / 로컬 프록시', ollama: 'Ollama(선택 사항)', unknown: '확인 안 됨', connected: '연결됨', unavailable: '사용 불가', observed: '마지막 시도 결과입니다. 현재 상태는 변경되었을 수 있습니다.', unobserved: '이 창에서는 아직 연결을 확인하지 않았습니다.', scope: '기존 로컬 브리지를 다시 연결합니다. 컴퓨터 페어링과 컨텍스트 권한은 별도로 관리됩니다.', close: '닫기', reconnect: '다시 연결', reconnecting: '다시 연결 중…', busy: '다른 로컬 작업이 진행 중입니다. 완료 후 다시 시도하세요.', failed: '로컬 브리지를 확인할 수 없습니다. 다시 시도하세요.' },
    'zh-CN': { title: '本地连接', core: 'Core / 本地代理', ollama: 'Ollama（可选）', unknown: '未检查', connected: '已连接', unavailable: '不可用', observed: '上次尝试的结果；当前状态可能已改变。', unobserved: '此窗口尚未检查连接。', scope: '重新连接现有本地桥接。计算机配对和上下文权限单独管理。', close: '关闭', reconnect: '重新连接', reconnecting: '正在重新连接…', busy: '另一项本地操作正在进行。请在完成后重试。', failed: '无法检查本地桥接。请重试。' },
    ar: { title: 'الاتصالات المحلية', core: 'Core / الوكيل المحلي', ollama: 'Ollama (اختياري)', unknown: 'لم يتم التحقق', connected: 'متصل', unavailable: 'غير متاح', observed: 'نتيجة المحاولة الأخيرة؛ ربما تغيرت الحالة الحالية.', unobserved: 'لم يتم التحقق من الاتصال في هذه النافذة بعد.', scope: 'يعيد توصيل الجسور المحلية الحالية. تتم إدارة إقران الكمبيوتر وأذونات السياق بشكل منفصل.', close: 'إغلاق', reconnect: 'إعادة الاتصال', reconnecting: 'جارٍ إعادة الاتصال…', busy: 'هناك إجراء محلي آخر قيد التنفيذ. حاول مجددًا عند انتهائه.', failed: 'تعذر التحقق من الجسور المحلية. حاول مجددًا.' },
  };
  // Same locale seat as the account footer: document language + its locale event.
  const language = () => Object.hasOwn(messages, document.documentElement?.lang) ? document.documentElement.lang : 'en';
  let locale = language();
  const unknown = () => ({ core: 'unknown', ollama: 'unknown', checked: false });
  const project = value => {
    const allowed = new Set(['unknown', 'connected', 'unavailable']);
    return value && allowed.has(value.core) && allowed.has(value.ollama) && typeof value.checked === 'boolean'
      ? { core: value.core, ollama: value.ollama, checked: value.checked } : unknown();
  };
  let state = unknown(), busy = false, feedback = '', attemptRevision = 0;
  const host = document.createElement('div');
  host.id = 'uptokey-native-local-connections';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{display:block;min-width:0;color:var(--dsw-alias-label-primary,#e8e8ed);font:inherit}
    button{font:inherit;color:inherit;cursor:pointer;border-radius:8px}
    .control{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;background:transparent;border:1px solid var(--dsw-alias-border-l3,#51515c);padding:6px 10px;font-size:12px;text-align:start}
    button:hover{background:var(--dsw-alias-interactive-bg-hover,#35353e)}
    button:focus-visible{outline:2px solid #977fff;outline-offset:3px}
    .dot{width:6px;height:6px;border-radius:50%;background:#93939c;flex:none}.dot[data-state=connected]{background:#72c59c}.dot[data-state=unavailable]{background:#e5ae70}
    :host([data-wide=false]) .name{display:none}:host([data-wide=false]) .control{width:36px;justify-content:center;padding:6px}:host([data-wide=false]) .dot{display:none}
    dialog{box-sizing:border-box;width:min(360px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:22px;border:1px solid var(--dsw-alias-border-l3,#51515c);border-radius:14px;background:var(--dsw-alias-bg-layer-2,#24242b);color:inherit;font:inherit;box-shadow:0 16px 64px #0005}
    dialog::backdrop{background:#0005}h2{font-size:16px;margin:0 0 18px;font-weight:600}dl{margin:0}dl>div{display:flex;justify-content:space-between;gap:16px;padding:9px 0;font-size:13px}dd{margin:0}p{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#adadb6);margin:16px 0}.actions{display:flex;gap:8px;justify-content:flex-end}.actions button{padding:8px 12px;border:1px solid var(--dsw-alias-border-l3,#51515c);background:transparent;font-size:12px}.actions button:disabled{opacity:.6;cursor:default}.message{min-height:18px}
  </style><button class="control" type="button" aria-haspopup="dialog"><span aria-hidden="true">↔</span><span class="name"></span><span class="dot" aria-hidden="true"></span></button>
  <dialog aria-labelledby="local-title" aria-describedby="local-scope"><h2 id="local-title"></h2><dl><div><dt data-core-label></dt><dd data-core></dd></div><div><dt data-ollama-label></dt><dd data-ollama></dd></div></dl><p data-observed></p><p id="local-scope"></p><p class="message" role="status" aria-live="polite"></p><div class="actions"><button type="button" data-close></button><button type="button" data-reconnect></button></div></dialog>`;
  const find = selector => shadow.querySelector(selector);
  const dialog = find('dialog'), reconnect = find('[data-reconnect]');
  function render() {
    const text = messages[locale];
    host.setAttribute('lang', locale);
    host.setAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    find('.name').textContent = text.title;
    find('#local-title').textContent = text.title;
    find('[data-core-label]').textContent = text.core;
    find('[data-ollama-label]').textContent = text.ollama;
    find('#local-scope').textContent = text.scope;
    find('[data-close]').textContent = text.close;
    find('[data-core]').textContent = text[state.core];
    find('[data-ollama]').textContent = text[state.ollama];
    find('.dot').dataset.state = state.core;
    find('.control').setAttribute('title', text.title);
    find('.control').setAttribute('aria-label', `${text.title}: ${text.core} — ${text[state.core]}`);
    find('[data-observed]').textContent = state.checked ? text.observed : text.unobserved;
    find('.message').textContent = feedback ? text[feedback] : '';
    reconnect.disabled = busy;
    reconnect.textContent = busy ? text.reconnecting : text.reconnect;
  }
  async function read() {
    const revision = ++attemptRevision;
    try {
      const value = await invoke('harness_local_connections', { reconnect: false });
      if (revision !== attemptRevision) return;
      state = project(value);
    } catch { if (revision !== attemptRevision) return; state = unknown(); }
    render();
  }
  find('.control').addEventListener('click', () => { if (!dialog.open) dialog.showModal(); });
  find('[data-close]').addEventListener('click', () => dialog.close());
  reconnect.addEventListener('click', async () => {
    if (busy) return;
    busy = true; const revision = ++attemptRevision; feedback = ''; render();
    try {
      const value = await invoke('harness_local_connections', { reconnect: true });
      if (revision === attemptRevision) state = project(value);
    }
    catch (error) {
      if (String(error) === 'local_connections_busy') feedback = 'busy';
      else { if (revision === attemptRevision) state = unknown(); feedback = 'failed'; }
    } finally { busy = false; render(); }
  });
  // Use the existing sidebar footer seat; preserve the account and metrics UI.
  // The observer only maintains this DOM seat across sidebar remounts. It does
  // not invoke IPC, refresh models, poll services, or write application state.
  const mount = () => {
    const footer = document.querySelector('.uptokey-harness-account-footer');
    if (!footer) return;
    if (host.parentNode !== footer) footer.prepend(host);
    const wide = footer.getAttribute('data-wide') || 'true';
    if (host.getAttribute('data-wide') !== wide) host.setAttribute('data-wide', wide);
  };
  function start() {
    locale = language();
    mount(); render(); void read();
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-wide'] });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  window.addEventListener('uptokey:local-connections', () => { void read(); });
  window.addEventListener('uptokey:locale', () => { locale = language(); render(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
