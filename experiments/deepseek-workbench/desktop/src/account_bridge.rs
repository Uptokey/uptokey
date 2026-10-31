//! Narrow account IPC. The existing native helper retains the paired core token.
use crate::diagnostics::{validate_account_request, Exporter};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{State, WebviewWindow};
#[path = "model_pages.rs"]
mod model_pages;

pub const INITIALIZATION_SCRIPT: &str = r#"(()=>{'use strict';
 if(location.origin!=='http://127.0.0.1:43180'||!window.__TAURI_INTERNALS__||typeof window.__TAURI_INTERNALS__.invoke!=='function')return;
 const nativeInvoke=window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
 const commands=new Set(['harness_account_request','harness_open_account_login','harness_complete_account_login','harness_open_account_page','harness_refresh_provider_models']);
 const invoke=(command,args)=>commands.has(command)?nativeInvoke(command,args):Promise.reject(new Error('account_command_denied'));
 const account=Object.freeze({ready:true,request:(path,input={})=>invoke('harness_account_request',{path,input})});
 Object.defineProperty(window,'__TAURI__',{value:Object.freeze({core:Object.freeze({invoke})}),writable:false,configurable:false});
 Object.defineProperty(window,'UptokeyHarnessAccount',{value:account,writable:false,configurable:false});
 Object.defineProperty(window,'UptokeyHarnessAccountReady',{value:true,writable:false,configurable:false});
 Object.defineProperty(window,'UptokeyDesktop',{value:Object.freeze({approveComputerFocus:ticket=>nativeInvoke('harness_computer_approve_focus',{ticket}),openAccountLogin:url=>invoke('harness_open_account_login',{url}),completeAccountLogin:url=>invoke('harness_complete_account_login',{url}),openModelPage:url=>invoke('harness_open_account_page',{url,kind:'model'}),openProviderPortal:providerId=>invoke('harness_open_account_page',{url:providerId,kind:'provider'}),openSubscriptionUrl:url=>invoke('harness_open_account_page',{url,kind:'subscription'}),refreshProviderModels:providerId=>invoke('harness_refresh_provider_models',{providerId})}),writable:false,configurable:false});
 window.dispatchEvent(new Event('uptokey:harness-account-ready'));
})();"#;

fn trusted_window(label: &str, url: &tauri::Url) -> bool {
    label == "workbench"
        && url.origin().ascii_serialization() == "http://127.0.0.1:43180"
        && url.username().is_empty()
        && url.password().is_none()
}
pub(crate) fn admit_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window
        .url()
        .map_err(|_| "account_window_denied".to_owned())?;
    if !trusted_window(window.label(), &url) {
        return Err("account_window_denied".to_owned());
    }
    Ok(())
}

#[tauri::command]
pub async fn harness_account_request(
    window: WebviewWindow,
    state: State<'_, Option<Exporter>>,
    path: String,
    input: Value,
) -> Result<Value, String> {
    admit_window(&window)?;
    validate_account_request(&path, &input).map_err(str::to_owned)?;
    let exporter = state
        .inner()
        .as_ref()
        .cloned()
        .ok_or("account_client_unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || exporter.account_request(&path, input))
        .await
        .map_err(|_| "account_unavailable".to_owned())?
        .map_err(str::to_owned)
}

fn verified_login_url(raw: &str) -> Result<tauri::Url, String> {
    let invalid = || "account_login_url_invalid".to_owned();
    if raw.len() > 2048 || raw.bytes().any(|byte| byte <= 0x20 || byte == 0x7f) {
        return Err(invalid());
    }
    let url = tauri::Url::parse(raw).map_err(|_| invalid())?;
    if url.origin().ascii_serialization() != "https://app.uptokey.com"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/api/account/native/authorize"
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let mut ids = 0;
    let mut languages = 0;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "id" => {
                ids += 1;
                let bytes = value.as_bytes();
                if bytes.len() != 36
                    || bytes[14] != b'4'
                    || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
                    || bytes.iter().enumerate().any(|(index, byte)| {
                        if matches!(index, 8 | 13 | 18 | 23) {
                            *byte != b'-'
                        } else {
                            !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase()
                        }
                    })
                {
                    return Err(invalid());
                }
            }
            "lang" => {
                languages += 1;
                if !matches!(
                    value.as_ref(),
                    "en" | "pt-BR" | "es" | "fr" | "de" | "it" | "ja" | "ko" | "zh-CN" | "ar"
                ) {
                    return Err(invalid());
                }
            }
            _ => return Err(invalid()),
        }
    }
    if ids != 1 || languages > 1 {
        return Err(invalid());
    }
    Ok(url)
}

#[tauri::command]
pub async fn harness_open_account_login(
    window: WebviewWindow,
    pending: State<'_, LoginReturn>,
    url: String,
) -> Result<(), String> {
    admit_window(&window)?;
    let verified = verified_login_url(&url)?;
    eprintln!("Uptokey Harness: account-login-dispatch-start");
    pending.arm(verified.as_str())?;
    let result = tauri::async_runtime::spawn_blocking(move || crate::browser::open(&verified))
        .await
        .map_err(|_| "account_browser_unavailable".to_owned())?;
    if result.is_err() {
        pending.clear(&url);
    }
    eprintln!(
        "Uptokey Harness: account-login-dispatch-{}",
        if result.is_ok() { "accepted" } else { "failed" }
    );
    result
}

// A return can only raise this same local window, once, for a login it opened.
// The system browser retains Auth0 cookies; no remote page gets native IPC.
#[derive(Default)]
pub struct LoginReturn(Mutex<Option<(String, Instant)>>);
impl LoginReturn {
    fn arm(&self, url: &str) -> Result<(), String> {
        *self.0.lock().map_err(|_| "account_return_unavailable")? =
            Some((url.to_owned(), Instant::now()));
        Ok(())
    }
    fn clear(&self, url: &str) {
        if let Ok(mut pending) = self.0.lock() {
            if pending.as_ref().is_some_and(|(current, _)| current == url) {
                pending.take();
            }
        }
    }
    fn consume(&self, url: &str) -> bool {
        let Ok(mut pending) = self.0.lock() else {
            return false;
        };
        if pending
            .as_ref()
            .is_some_and(|(_, opened)| opened.elapsed() >= Duration::from_secs(600))
        {
            pending.take();
        }
        if pending.as_ref().is_some_and(|(current, _)| current == url) {
            pending.take();
            true
        } else {
            false
        }
    }
}

#[tauri::command]
pub async fn harness_complete_account_login(
    window: WebviewWindow,
    pending: State<'_, LoginReturn>,
    state: State<'_, Option<Exporter>>,
    url: String,
) -> Result<bool, String> {
    admit_window(&window)?;
    let verified = verified_login_url(&url)?;
    let exporter = state
        .inner()
        .as_ref()
        .cloned()
        .ok_or("account_client_unavailable")?;
    let response = tauri::async_runtime::spawn_blocking(move || {
        exporter.account_request("status", serde_json::json!({}))
    })
    .await
    .map_err(|_| "account_unavailable")?
    .map_err(str::to_owned)?;
    if response.get("status").and_then(Value::as_u64) != Some(200)
        || response
            .pointer("/body/authenticated")
            .and_then(Value::as_bool)
            != Some(true)
        || !pending.consume(verified.as_str())
    {
        return Ok(false);
    }
    window
        .unminimize()
        .map_err(|_| "account_return_unavailable")?;
    window.show().map_err(|_| "account_return_unavailable")?;
    window
        .set_focus()
        .map_err(|_| "account_return_unavailable")?;
    Ok(true)
}

fn verified_account_page(raw: &str, kind: &str) -> Result<tauri::Url, String> {
    if kind == "subscription" {
        return crate::account_urls::subscription_url(raw);
    }
    if kind == "model" {
        return model_pages::verified_model_page_url(raw);
    }
    if kind == "provider" {
        return model_pages::verified_provider_portal(raw);
    }
    let invalid = || "account_page_invalid".to_owned();
    if kind != "help" || raw.len() > 2048 {
        return Err(invalid());
    }
    let url = tauri::Url::parse(raw).map_err(|_| invalid())?;
    if url.origin().ascii_serialization() != "https://docs.uptokey.com"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(
            url.path(),
            "/en/"
                | "/pt-br/"
                | "/es/"
                | "/fr/"
                | "/de/"
                | "/it/"
                | "/ja/"
                | "/ko/"
                | "/zh-cn/"
                | "/ar/"
        )
    {
        return Err(invalid());
    }
    Ok(url)
}

#[tauri::command]
pub async fn harness_open_account_page(
    window: WebviewWindow,
    url: String,
    kind: String,
) -> Result<(), String> {
    admit_window(&window)?;
    let verified = verified_account_page(&url, &kind)?;
    tauri::async_runtime::spawn_blocking(move || crate::browser::open(&verified))
        .await
        .map_err(|_| "account_browser_unavailable".to_owned())?
}

#[tauri::command]
pub async fn harness_refresh_provider_models(
    window: WebviewWindow,
    state: State<'_, Option<Exporter>>,
    provider_id: String,
) -> Result<Value, String> {
    admit_window(&window)?;
    model_pages::verified_provider_portal(&provider_id)?;
    let exporter = state
        .inner()
        .as_ref()
        .cloned()
        .ok_or("provider_model_refresh_unavailable".to_owned())?;
    tauri::async_runtime::spawn_blocking(move || exporter.refresh_provider_models(&provider_id))
        .await
        .map_err(|_| "provider_model_refresh_unavailable".to_owned())?
        .map_err(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "419e988d-c7bc-4182-8ed0-70b939d93459";
    #[test]
    fn login_return_is_exact_once_and_expires() {
        let pending = LoginReturn::default();
        assert!(!pending.consume("first"));
        pending.arm("first").unwrap();
        assert!(!pending.consume("other"));
        pending.arm("second").unwrap();
        assert!(!pending.consume("first"));
        assert!(pending.consume("second"));
        assert!(!pending.consume("second"));
        *pending.0.lock().unwrap() =
            Some(("expired".into(), Instant::now() - Duration::from_secs(601)));
        assert!(!pending.consume("expired"));
        pending.arm("cancelled").unwrap();
        pending.clear("cancelled");
        assert!(!pending.consume("cancelled"));
    }
    #[test]
    fn public_account_pages_have_no_arbitrary_destinations() {
        assert!(verified_account_page("https://docs.uptokey.com/pt-br/", "help").is_ok());
        for (url, kind) in [
            ("https://evil.example/en/", "help"),
            ("https://docs.uptokey.com/en/?token=synthetic", "help"),
            ("https://docs.uptokey.com/en/", "unknown"),
            ("https://docs.uptokey.com/en/", "subscription"),
        ] {
            assert!(verified_account_page(url, kind).is_err())
        }
    }
    #[test]
    fn model_and_provider_pages_use_distinct_canonical_policies() {
        assert!(verified_account_page("https://ollama.com/library/qwen3:4b", "model").is_ok());
        assert!(verified_account_page("https://huggingface.co/Qwen/Qwen3-8B", "model").is_ok());
        assert_eq!(
            verified_account_page("groq", "provider").unwrap().as_str(),
            "https://console.groq.com/"
        );
        for (raw, kind) in [
            ("https://ollama.com/library/qwen3:4b", "help"),
            ("https://platform.openai.com/", "provider"),
            ("openai", "model"),
            ("groq?key=secret", "provider"),
            ("https://ollama.com/download?token=secret", "model"),
        ] {
            assert!(verified_account_page(raw, kind).is_err());
        }
        assert!(verified_account_page("https://docs.uptokey.com/pt-br/", "help").is_ok());
        assert!(verified_account_page("https://docs.uptokey.com/pt-br/", "model").is_ok());
    }
    #[test]
    fn initialization_keeps_model_and_provider_input_in_the_existing_page_command() {
        assert!(INITIALIZATION_SCRIPT
            .contains("openModelPage:url=>invoke('harness_open_account_page',{url,kind:'model'})"));
        assert!(INITIALIZATION_SCRIPT.contains("openProviderPortal:providerId=>invoke('harness_open_account_page',{url:providerId,kind:'provider'})"));
        assert!(INITIALIZATION_SCRIPT.contains("openSubscriptionUrl:url=>invoke('harness_open_account_page',{url,kind:'subscription'})"));
        assert!(INITIALIZATION_SCRIPT.contains("refreshProviderModels:providerId=>invoke('harness_refresh_provider_models',{providerId})"));
    }
    #[test]
    fn ipc_is_confined_to_workbench_origin() {
        assert!(trusted_window(
            "workbench",
            &tauri::Url::parse("http://127.0.0.1:43180/").unwrap()
        ));
        for (label, url) in [
            ("other", "http://127.0.0.1:43180/"),
            ("workbench", "http://localhost:43180/"),
            ("workbench", "https://127.0.0.1:43180/"),
            ("workbench", "http://127.0.0.1:43181/"),
            ("workbench", "http://user@127.0.0.1:43180/"),
            ("workbench", "tauri://localhost/recovery.html"),
        ] {
            assert!(!trusted_window(label, &tauri::Url::parse(url).unwrap()));
        }
    }
    #[test]
    fn official_login_accepts_canonical_locales() {
        assert!(verified_login_url(&format!(
            "https://app.uptokey.com/api/account/native/authorize?id={ID}"
        ))
        .is_ok());
        for locale in [
            "en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar",
        ] {
            assert!(verified_login_url(&format!(
                "https://app.uptokey.com/api/account/native/authorize?id={ID}&lang={locale}"
            ))
            .is_ok());
        }
    }
    #[test]
    fn login_rejects_other_destinations_or_ambiguous_query() {
        for raw in [format!("https://evil.example/api/account/native/authorize?id={ID}"),format!("http://app.uptokey.com/api/account/native/authorize?id={ID}"),format!("https://app.uptokey.com/api/account/native/authorize?id={ID}&id={ID}"),format!("https://app.uptokey.com/api/account/native/authorize?id={ID}&lang=en&lang=en"),format!("https://app.uptokey.com/api/account/native/authorize?id={ID}&lang=unknown"),format!("https://app.uptokey.com/api/account/native/authorize?id={ID}&returnTo=https://evil.example"),format!("https://app.uptokey.com/api/account/native/authorize?id={ID}#x"),format!("https://app.uptokey.com/api/account/native/authorize?id={ID}\n"),"https://app.uptokey.com/api/account/native/authorize?id=invalid".to_owned()]{assert!(verified_login_url(&raw).is_err());}
    }
}
