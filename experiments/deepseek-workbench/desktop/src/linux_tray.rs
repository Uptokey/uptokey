use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Manager, Runtime, Window, WindowEvent,
};

const OPEN_ACTION: &str = "tray-open";
const QUIT_ACTION: &str = "tray-quit";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Action {
    Open,
    Quit,
    Ignore,
}

fn action(id: &str) -> Action {
    match id {
        OPEN_ACTION => Action::Open,
        QUIT_ACTION => Action::Quit,
        _ => Action::Ignore,
    }
}

fn hides_on_close(label: &str) -> bool {
    label == "workbench"
}

pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if hides_on_close(window.label()) {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

fn show_workbench<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("workbench") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ACTION, "Open Uptokey", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ACTION, "Quit Uptokey", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("uptokey")
        .menu(&menu)
        .tooltip("Uptokey")
        .on_menu_event(|app, event| match action(event.id().as_ref()) {
            Action::Open => show_workbench(app),
            Action::Quit => app.exit(0),
            Action::Ignore => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_exposes_only_fixed_local_actions() {
        assert_eq!(action(OPEN_ACTION), Action::Open);
        assert_eq!(action(QUIT_ACTION), Action::Quit);
        for value in ["", "restart-runtime", "open-url", "tray-open-extra"] {
            assert_eq!(action(value), Action::Ignore);
        }
        assert!(hides_on_close("workbench"));
        assert!(!hides_on_close("other"));
    }
}
