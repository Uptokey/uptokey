//! Shared accepted Harness window and native menus. Both entries use this
//! source; it owns no Builder, core, supervisor or alternate authentication.
#[cfg(target_os = "linux")]
use crate::linux_tray;
use crate::{
    account_bridge, approved_context, computer_use, diagnostics, export_save, notification_bridge,
    public_api, theme_bridge, local_connections,
};
use std::path::PathBuf;
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

// Retain confirmed imports until the original Workspace services are ready.
// This queue grants no host filesystem access; it contains isolated paths only.
const WORKSPACE_IMPORT_SCRIPT: &str = r#"(function(){'use strict';const pending=new Set();const valid=/^\/workspace\/import-[a-f0-9]{32}$/;Object.defineProperty(window,'UptokeyHarnessWorkspaceImports',{value:Object.freeze({enqueue(project){if(typeof project!=='string'||!valid.test(project))return false;pending.add(project);window.dispatchEvent(new Event('uptokey:workspace-import-queued'));return true;},take(){const projects=Array.from(pending);pending.clear();return projects;}})});})();"#;

pub(crate) fn local_origin(url: &Url) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(43180)
        && url.username().is_empty()
        && url.password().is_none()
}

pub(crate) fn preserve_running_workspace(
    action: &str,
    receipt: &serde_json::Value,
    current: &Url,
) -> bool {
    action == "start-runtime"
        && receipt.get("alreadyRunning").and_then(|v| v.as_bool()) == Some(true)
        && local_origin(current)
        && current.path() == "/"
        && current.query().is_none()
}

pub(crate) fn startup_url(raw: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw).map_err(|_| "invalid-startup-url")?;
    if !local_origin(&url) || url.path() != "/" || url.fragment().is_some() {
        return Err("invalid-startup-origin");
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 1
        || pairs[0].0 != "token"
        || pairs[0].1.len() < 16
        || pairs[0].1.len() > 4096
        || !pairs[0]
            .1
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b))
    {
        return Err("invalid-startup-token");
    }
    Ok(url)
}

pub(crate) fn base64url(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

pub(crate) fn startup_cookie_with_policy(
    receipt: &serde_json::Value,
    same_site: tauri::webview::cookie::SameSite,
) -> Result<tauri::webview::Cookie<'static>, &'static str> {
    let value = receipt
        .get("cookie")
        .and_then(|value| value.as_object())
        .ok_or("startup-cookie-missing")?;
    if value.len() != 3 {
        return Err("startup-cookie-invalid");
    }
    let name = value
        .get("name")
        .and_then(|value| value.as_str())
        .ok_or("startup-cookie-invalid")?;
    let body = value
        .get("value")
        .and_then(|value| value.as_str())
        .ok_or("startup-cookie-invalid")?;
    let max_age = value
        .get("maxAgeSeconds")
        .and_then(|value| value.as_i64())
        .ok_or("startup-cookie-invalid")?;
    let suffix = name
        .strip_prefix("dsh-auth-")
        .ok_or("startup-cookie-invalid")?;
    let parts: Vec<_> = body.split('.').collect();
    if !base64url(suffix, 20, 128)
        || parts.len() != 3
        || parts[0] != "v1"
        || !base64url(parts[1], 8, 4096)
        || !base64url(parts[2], 8, 128)
        || !(1..=10 * 366 * 86400).contains(&max_age)
    {
        return Err("startup-cookie-invalid");
    }
    Ok(
        tauri::webview::Cookie::build((name.to_owned(), body.to_owned()))
            .domain("127.0.0.1")
            .path("/")
            .http_only(true)
            .secure(false)
            .same_site(same_site)
            .max_age(tauri::webview::cookie::time::Duration::seconds(max_age))
            .build(),
    )
}

pub(crate) fn startup_cookie(
    receipt: &serde_json::Value,
) -> Result<tauri::webview::Cookie<'static>, &'static str> {
    startup_cookie_with_policy(receipt, tauri::webview::cookie::SameSite::Strict)
}

pub(crate) fn transitional_startup_cookie(
    receipt: &serde_json::Value,
) -> Result<tauri::webview::Cookie<'static>, &'static str> {
    startup_cookie_with_policy(receipt, tauri::webview::cookie::SameSite::Lax)
}

pub(crate) fn install_startup_cookie(
    window: &tauri::WebviewWindow,
    cookie: tauri::webview::Cookie<'static>,
    url: &Url,
    policy: tauri::webview::cookie::SameSite,
) -> Result<(), &'static str> {
    let name = cookie.name().to_owned();
    let value = cookie.value().to_owned();
    window
        .set_cookie(cookie)
        .map_err(|_| "startup-cookie-unavailable")?;
    let accepted = window
        .cookies_for_url(url.clone())
        .map_err(|_| "startup-cookie-unavailable")?
        .into_iter()
        .any(|stored| {
            stored.name() == name
                && stored.value() == value
                && stored.http_only() == Some(true)
                && stored.secure() == Some(false)
                && stored.same_site() == Some(policy)
        });
    if accepted {
        Ok(())
    } else {
        Err("startup-cookie-unavailable")
    }
}

#[derive(Default)]
pub(crate) struct StartupCookiePromotion(std::sync::Mutex<Option<tauri::webview::Cookie<'static>>>);
impl StartupCookiePromotion {
    fn stage(&self, cookie: tauri::webview::Cookie<'static>) -> Result<(), &'static str> {
        *self.0.lock().map_err(|_| "startup-cookie-unavailable")? = Some(cookie);
        Ok(())
    }
    fn take(&self) -> Option<tauri::webview::Cookie<'static>> {
        self.0.lock().ok()?.take()
    }
    fn clear(&self) {
        if let Ok(mut value) = self.0.lock() {
            value.take();
        }
    }
}

pub(crate) fn clean_startup_url(raw: &str) -> Result<Url, &'static str> {
    startup_url(raw)?;
    Url::parse("http://127.0.0.1:43180/").map_err(|_| "startup-url-invalid")
}

pub(crate) fn navigation_allowed(url: &Url) -> bool {
    local_origin(url)
        || url.as_str() == stopped_url()
        || url.as_str() == recovery_url()
        || url.as_str() == "about:blank"
        || url.as_str() == "about:srcdoc"
        || (url.scheme() == "blob"
            && Url::parse(url.path()).is_ok_and(|inner| local_origin(&inner)))
}
pub(crate) fn stopped_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/stopped.html"
    } else {
        "tauri://localhost/stopped.html"
    }
}
pub(crate) fn recovery_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/recovery.html"
    } else {
        "tauri://localhost/recovery.html"
    }
}
pub(crate) fn external_url_allowed(url: &Url) -> bool {
    // Open web links only. Never hand local session tokens, files, custom
    // protocols or URLs containing credentials to the operating system.
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => {
            let host = host.trim_end_matches('.');
            host.contains('.')
                && host != "localhost"
                && !host.ends_with(".localhost")
                && !host.ends_with(".local")
                && !host.ends_with(".internal")
        }
        _ => false,
    }
}

pub(crate) fn mount(
    app: &mut tauri::App,
    exporter: Option<diagnostics::Exporter>,
    profile: PathBuf,
    inspect: bool,
    initial: Url,
) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(exporter.clone());
    app.manage(account_bridge::LoginReturn::default());
    app.manage(StartupCookiePromotion::default());
    app.manage(theme_bridge::ThemeBridge::default());
    app.manage(public_api::Delivery::default());
    app.manage(computer_use::NativeState::default());
    let native_actions = local_connections::NativeActions::default();
    app.manage(native_actions.clone());
    if let Some(exporter) = exporter {
        use tauri::menu::{Menu, MenuItem, Submenu};
        let export = MenuItem::with_id(
            app,
            "export-diagnostics",
            "Export diagnostics",
            true,
            None::<&str>,
        )?;
        let workspace_export = MenuItem::with_id(
            app,
            "export-workspace",
            "Export workspace…",
            true,
            None::<&str>,
        )?;
        let workspace_import = MenuItem::with_id(
            app,
            "import-workspace",
            "Import project…",
            true,
            None::<&str>,
        )?;
        let folder_import = MenuItem::with_id(
            app,
            "import-folder",
            "Import project folder…",
            true,
            None::<&str>,
        )?;
        let context_import = MenuItem::with_id(
            app,
            approved_context::ACTION,
            "Import approved context…",
            true,
            None::<&str>,
        )?;
        let context_connect = MenuItem::with_id(
            app,
            approved_context::CONNECT_ACTION,
            "Connect approved context…",
            true,
            None::<&str>,
        )?;
        let context_revoke = MenuItem::with_id(
            app,
            approved_context::REVOKE_ACTION,
            "Disconnect approved context…",
            true,
            None::<&str>,
        )?;
        let api_import =
            MenuItem::with_id(app, "import-api", "Add public API…", true, None::<&str>)?;
        let computer = computer_use::Controls::new(app.handle())?;
        let reconnect = MenuItem::with_id(
            app,
            "reconnect-local",
            "Reconnect local services",
            true,
            None::<&str>,
        )?;
        let account = MenuItem::with_id(
            app,
            "uptokey-account",
            "Uptokey account",
            true,
            None::<&str>,
        )?;
        let restart = MenuItem::with_id(
            app,
            "restart-runtime",
            "Restart Harness runtime",
            true,
            None::<&str>,
        )?;
        let start = MenuItem::with_id(
            app,
            "start-runtime",
            "Start Harness runtime",
            true,
            None::<&str>,
        )?;
        let stop = MenuItem::with_id(
            app,
            "stop-runtime",
            "Stop Harness runtime",
            true,
            None::<&str>,
        )?;
        let submenu = Submenu::with_items(
            app,
            "Uptokey",
            true,
            &[
                &account,
                &api_import,
                &computer.submenu,
                &folder_import,
                &workspace_import,
                &context_connect,
                &context_import,
                &context_revoke,
                &workspace_export,
                &reconnect,
                &start,
                &stop,
                &restart,
                &export,
            ],
        )?;
        app.set_menu(Menu::with_items(app, &[&submenu])?)?;
        let busy = native_actions.busy.clone();
        let approved_context = approved_context::NativeState::default();
        app.on_menu_event(move |_app,event| {
                    let action=event.id().as_ref().to_owned();
                    if computer_use::handle_event(&action,_app,&exporter,&computer){return}
                    if approved_context::handle_event(&action,_app,&exporter,&busy,&context_import,&context_connect,&context_revoke,&approved_context){return}
                    if action=="uptokey-account" {
                        if let Some(window)=_app.get_webview_window("workbench") {
                            let _=window.eval("window.dispatchEvent(new CustomEvent('uptokey:user-action',{detail:{action:'account'}}))");
                        }
                        return;
                    }
                    if matches!(action.as_str(),"restart-runtime"|"start-runtime"|"stop-runtime") {
                        if busy.swap(true,std::sync::atomic::Ordering::SeqCst){return}
                        let app=_app.clone();let restart=restart.clone();let start=start.clone();let stop=stop.clone();let exporter=exporter.clone();let busy=busy.clone();let native_actions=native_actions.clone();
                        std::thread::spawn(move||{
                            native_actions.invalidate();
                            if let Some(window)=app.get_webview_window("workbench") {
                                if window.url().is_ok_and(|url|local_origin(&url)) {
                                    let _=window.eval("window.dispatchEvent(new Event('uptokey:local-connections'))");
                                }
                            }
                            if action!="start-runtime" {app.state::<computer_use::NativeState>().shutdown(false);}
                            let _=restart.set_enabled(false);let _=start.set_enabled(false);let _=stop.set_enabled(false);
                            let control=if action=="start-runtime"{&start}else if action=="stop-runtime"{&stop}else{&restart};
                            let label=if action=="start-runtime"{"Start Harness runtime"}else if action=="stop-runtime"{"Stop Harness runtime"}else{"Restart Harness runtime"};
                            let _=control.set_text("Updating Harness runtime…");
                            let result=(||->Result<(),&'static str>{
                                let receipt=if action=="restart-runtime"{exporter.restart_runtime()?}else{exporter.runtime_state(action=="start-runtime")?};
                                let target=if action=="stop-runtime"{Url::parse(stopped_url()).map_err(|_|"stopped-url-invalid")?}else{clean_startup_url(receipt.get("url").and_then(|v|v.as_str()).ok_or("restart-url-missing")?)?};
                                let window=app.get_webview_window("workbench").ok_or("restart-window-unavailable")?;
                                let preserve=window.url().is_ok_and(|current|preserve_running_workspace(&action,&receipt,&current));
                                if !preserve {
                                    if action!="stop-runtime"{
                                        let promotion=app.state::<StartupCookiePromotion>();
                                        let strict=startup_cookie(&receipt)?;
                                        install_startup_cookie(&window,transitional_startup_cookie(&receipt)?,&target,tauri::webview::cookie::SameSite::Lax)?;
                                        promotion.stage(strict)?;
                                        if window.navigate(target).is_err(){promotion.clear();return Err("restart-navigation-failed")}
                                    }else{window.navigate(target).map_err(|_|"restart-navigation-failed")?;}
                                }
                                Ok(())
                            })();
                            let _=control.set_text(if result.is_ok(){label}else{"Runtime action failed — retry"});
                            let _=restart.set_enabled(true);let _=start.set_enabled(true);let _=stop.set_enabled(true);busy.store(false,std::sync::atomic::Ordering::SeqCst);
                        });
                        return;
                    }
                    if !matches!(action.as_str(),"export-diagnostics"|"export-workspace"|"import-workspace"|"import-folder"|"import-api"|"reconnect-local") || busy.swap(true,std::sync::atomic::Ordering::SeqCst){return}
                    let app=_app.clone();let exporter=exporter.clone();let export=export.clone();let workspace_export=workspace_export.clone();let workspace_import=workspace_import.clone();let folder_import=folder_import.clone();let api_import=api_import.clone();let reconnect=reconnect.clone();let busy=busy.clone();let native_actions=native_actions.clone();
                    std::thread::spawn(move || {
                        if action=="reconnect-local" {
                            let label=match native_actions.reconnect(&exporter){Ok(state)=>state.menu_label(),Err(_)=>"Reconnect failed — retry"};
                            let _=reconnect.set_text(label);
                            if let Some(window)=app.get_webview_window("workbench") {
                                if window.url().is_ok_and(|url|local_origin(&url)) {
                                    let _=window.eval("window.dispatchEvent(new Event('uptokey:local-connections'))");
                                }
                            }
                        }else if action=="import-api"{
                            use tauri_plugin_dialog::DialogExt;
                            if let Some(selected)=app.dialog().file().add_filter("Public OpenAPI specification",&["json"]).blocking_pick_file(){
                                let _=api_import.set_text("Adding public API…");
                                let result=selected.into_path().map_err(|_|"api-path-invalid").and_then(|path|exporter.import_public_api(&path));
                                match result{
                                    Ok(receipt)=>{
                                        let result=(||->Result<(),&'static str>{
                                            let delivery=app.state::<public_api::Delivery>();let (id,ack)=delivery.begin()?;
                                            let sent=public_api::delivery_script(&receipt,&id).and_then(|script|app.get_webview_window("workbench").ok_or("api-window-unavailable")?.eval(script).map_err(|_|"api-readiness-unavailable"));
                                            let queued=sent.is_ok()&&ack.recv_timeout(std::time::Duration::from_secs(2))==Ok(true);
                                            delivery.cancel(&id);
                                            if queued{Ok(())}else{Err("api-readiness-unavailable")}
                                        })();
                                        let _=api_import.set_text(if result.is_ok(){"Add public API…"}else{"API saved — reopen workbench"});
                                    },
                                    Err(_)=>{app.dialog().message("Could not add this API. Select OpenAPI 3 JSON with one public HTTPS server and GET operations without authentication.").title("Uptokey").blocking_show();let _=api_import.set_text("Add public API…");}
                                }
                            }
                        }else if action=="import-workspace"||action=="import-folder"{
                            use tauri_plugin_dialog::DialogExt;
                            let is_folder=action=="import-folder";
                            let control=if is_folder{&folder_import}else{&workspace_import};
                            let label=if is_folder{"Import project folder…"}else{"Import project…"};
                            let selected=if is_folder{app.dialog().file().blocking_pick_folder()}else{app.dialog().file().add_filter("Uptokey project backup",&["uptokey","zip"]).blocking_pick_file()};
                            if let Some(selected)=selected{
                                let _=control.set_text("Importing project…");
                                let result=selected.into_path().map_err(|_|"workspace-path-invalid").and_then(|path|if is_folder{exporter.import_folder(&path).map(|receipt|receipt.project)}else{match diagnostics::workspace_archive_format(&path)?{diagnostics::WorkspaceArchiveFormat::Encrypted=>exporter.import_workspace_encrypted(&path),diagnostics::WorkspaceArchiveFormat::Zip=>exporter.import_workspace(&path)}}).and_then(|project|{
                                    let project=serde_json::to_string(&project).map_err(|_|"workspace-import-invalid")?;
                                    app.get_webview_window("workbench").ok_or("workspace-window-unavailable")?.eval(format!("window.UptokeyHarnessWorkspaceImports.enqueue({project})")).map_err(|_|"workspace-navigation-unavailable")
                                });
                                match result{
                                    Ok(())=>{let _=control.set_text(label);},
                                    Err(_)=>{let _=control.set_text("Project import failed — retry");app.dialog().message("Could not import this project. Choose a supported Uptokey backup or ZIP, up to 34 MiB. Existing files are unchanged.").title("Uptokey").blocking_show();}
                                }
                            }
                        }else if action=="export-workspace"{
                              use tauri_plugin_dialog::DialogExt;
                              let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value|value.as_millis()).unwrap_or(0);
                              let result=exporter.workspace_export_directory().and_then(|directory|{
                                  let selected=app.dialog().file().set_title("Export workspace").add_filter("Uptokey encrypted backup",&["uptokey"]).add_filter("ZIP archive",&["zip"])
                                      .set_directory(directory).set_file_name(format!("uptokey-workspace-{stamp}.uptokey")).blocking_save_file();
                                  if let Some(selected)=selected{
                                      let _=workspace_export.set_text("Exporting workspace…");
                                      selected.into_path().map_err(|_|"workspace-path-invalid").and_then(|destination|{
                                          let archive=match diagnostics::workspace_archive_format(&destination)?{diagnostics::WorkspaceArchiveFormat::Encrypted=>exporter.export_workspace_encrypted_bytes()?,diagnostics::WorkspaceArchiveFormat::Zip=>exporter.export_workspace_bytes()?};
                                          export_save::save_export_bytes(&archive,&destination)
                                      })
                                  }else{Ok(())}
                              });
                              let _=workspace_export.set_text(if result.is_ok(){"Export workspace…"}else{"Workspace export failed — retry"});
                              if result.is_err(){app.dialog().message("Could not save this workspace. Use .uptokey for an encrypted backup or .zip for an explicit plaintext archive.").title("Uptokey").blocking_show();}
                        }else{
                            use tauri_plugin_dialog::DialogExt;
                            let stamp=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value|value.as_millis()).unwrap_or(0);
                            let result=exporter.diagnostics_export_directory().and_then(|directory|{
                                let selected=app.dialog().file().set_title("Export diagnostics").add_filter("JSON report",&["json"])
                                    .set_directory(directory).set_file_name(format!("uptokey-runtime-{stamp}.json")).blocking_save_file();
                                if let Some(selected)=selected{
                                    let _=export.set_text("Exporting diagnostics…");
                                    selected.into_path().map_err(|_|"diagnostics-path-invalid").and_then(|destination|{
                                        exporter.export().and_then(|path|export_save::save_diagnostics(&path,&destination))
                                    })
                                }else{Ok(())}
                            });
                            let _=export.set_text(if result.is_ok(){"Export diagnostics"}else{"Export diagnostics — failed; retry"});
                            if result.is_err(){app.dialog().message("Could not save diagnostics. Choose a new filename in a writable folder.").title("Uptokey").blocking_show();}
                        }
                        busy.store(false,std::sync::atomic::Ordering::SeqCst);
                    });
                });
    }
    let mut window = WebviewWindowBuilder::new(app, "workbench", WebviewUrl::External(initial))
        .title("Uptokey")
        .inner_size(1280.0, 850.0)
        .min_inner_size(800.0, 600.0)
        .data_directory(profile)
        .disable_drag_drop_handler()
        .initialization_script(account_bridge::INITIALIZATION_SCRIPT)
        .initialization_script(local_connections::INITIALIZATION_SCRIPT)
        .initialization_script(theme_bridge::INITIALIZATION_SCRIPT)
        .initialization_script(WORKSPACE_IMPORT_SCRIPT)
        .initialization_script(public_api::INITIALIZATION_SCRIPT)
        .initialization_script(notification_bridge::INITIALIZATION_SCRIPT)
        .on_navigation(navigation_allowed)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished)
                && local_origin(payload.url())
                && payload.url().path() == "/"
                && payload.url().query().is_none()
            {
                if let Some(cookie) = window.app_handle().state::<StartupCookiePromotion>().take() {
                    let window = window.clone();
                    let target = payload.url().clone();
                    std::thread::spawn(move || {
                        if install_startup_cookie(
                            &window,
                            cookie,
                            &target,
                            tauri::webview::cookie::SameSite::Strict,
                        )
                        .is_err()
                        {
                            if let Ok(recovery) = Url::parse(recovery_url()) {
                                let _ = window.navigate(recovery);
                            }
                        }
                    });
                }
            }
        })
        .on_new_window(move |url, _| {
            if external_url_allowed(&url) {
                if tauri_plugin_opener::open_url(url.as_str(), None::<&str>).is_err() {
                    // URLs can contain private parameters. Do not log them.
                    eprintln!("Uptokey Harness Lab: external-browser-open-failed");
                } else if cfg!(debug_assertions) && inspect {
                    eprintln!("Uptokey Harness Lab: external-link-dispatched");
                }
            } else if cfg!(debug_assertions) && inspect {
                eprintln!("Uptokey Harness Lab: external-link-denied");
            }
            NewWindowResponse::Deny
        });
    #[cfg(debug_assertions)]
    if inspect {
        window = window.additional_browser_args(
            "--remote-debugging-address=127.0.0.1 --remote-debugging-port=43196",
        );
    }
    #[cfg(not(debug_assertions))]
    let _ = inspect;
    window.build().map_err(|_| "webview-create-failed")?;
    #[cfg(target_os = "linux")]
    linux_tray::install(app).map_err(|_| "linux-tray-unavailable")?;
    Ok(())
}

/// Continue through the existing runtime lifecycle after the sole core
/// supervisor is installed. Recovery remains visible on any admission failure.
pub(crate) fn start_runtime(app: tauri::AppHandle, exporter: diagnostics::Exporter) {
    std::thread::spawn(move || {
        let result = (|| -> Result<(), &'static str> {
            let receipt = exporter.runtime_state(true)?;
            exporter.product_contract()?;
            let target = clean_startup_url(
                receipt
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or("startup-url-missing")?,
            )?;
            let window = app
                .get_webview_window("workbench")
                .ok_or("startup-window-unavailable")?;
            let promotion = app.state::<StartupCookiePromotion>();
            let strict = startup_cookie(&receipt)?;
            install_startup_cookie(
                &window,
                transitional_startup_cookie(&receipt)?,
                &target,
                tauri::webview::cookie::SameSite::Lax,
            )?;
            promotion.stage(strict)?;
            if window.navigate(target).is_err() {
                promotion.clear();
                return Err("startup-navigation-failed");
            }
            Ok(())
        })();
        if let Err(code) = result {
            // These are fixed internal error codes, never helper output or user data.
            // Keep the failed stage observable while preserving the recovery window.
            eprintln!("Uptokey: harness-runtime-unavailable ({code})");
        }
    });
}
