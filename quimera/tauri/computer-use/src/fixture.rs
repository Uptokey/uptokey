//! Deliberately synthetic application for native acceptance; never attaches to another app.
use serde_json::json;
use std::{io::Write, ptr::null_mut};
use windows_sys::Win32::{
    Foundation::*, System::LibraryLoader::GetModuleHandleW, UI::WindowsAndMessaging::*,
};
use windows_sys::Win32::{
    Graphics::Gdi::{COLOR_WINDOW, ClientToScreen},
    UI::Input::KeyboardAndMouse::SetFocus,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match message {
            WM_COMMAND if wparam as u32 & 0xffff == 102 => {
                let edit = GetDlgItem(hwnd, 101);
                let mut text = [0u16; 1025];
                let n = GetWindowTextW(edit, text.as_mut_ptr(), 1025);
                let value = String::from_utf16_lossy(&text[..n.max(0) as usize]);
                let status = GetDlgItem(hwnd, 103);
                SetWindowTextW(status, wide(&format!("Received: {value}")).as_ptr());
                println!("{}", json!({"event":"submitted","text":value}));
                let _ = std::io::stdout().flush();
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }
}
pub fn run() -> Result<(), &'static str> {
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let class = wide("UptokeyComputerSyntheticFixture");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            hbrBackground: (COLOR_WINDOW + 1) as _,
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            ..std::mem::zeroed()
        };
        if RegisterClassW(&wc) == 0 {
            return Err("fixture_class_failed");
        }
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            wide("Uptokey computer use — synthetic acceptance").as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            180,
            180,
            650,
            370,
            null_mut(),
            null_mut(),
            instance,
            null_mut(),
        );
        if hwnd.is_null() {
            return Err("fixture_window_failed");
        }
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("Synthetic fixture: text is local to this temporary window.").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            30,
            20,
            570,
            25,
            hwnd,
            100 as _,
            instance,
            null_mut(),
        );
        let edit = CreateWindowExW(
            WS_EX_CLIENTEDGE,
            wide("EDIT").as_ptr(),
            wide("").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL as u32,
            30,
            65,
            550,
            40,
            hwnd,
            101 as _,
            instance,
            null_mut(),
        );
        CreateWindowExW(
            0,
            wide("BUTTON").as_ptr(),
            wide("Submit canary").as_ptr(),
            WS_CHILD | WS_VISIBLE | WS_TABSTOP,
            30,
            130,
            200,
            45,
            hwnd,
            102 as _,
            instance,
            null_mut(),
        );
        CreateWindowExW(
            0,
            wide("STATIC").as_ptr(),
            wide("Waiting for canary").as_ptr(),
            WS_CHILD | WS_VISIBLE,
            30,
            210,
            550,
            70,
            hwnd,
            103 as _,
            instance,
            null_mut(),
        );
        ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        SetFocus(edit);
        let mut bounds: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut bounds);
        let mut origin = POINT { x: 0, y: 0 };
        ClientToScreen(hwnd, &mut origin);
        println!(
            "{}",
            json!({"event":"ready","id":hwnd as usize as u32,"pid":std::process::id(),"edit":{"x":origin.x-bounds.left+100,"y":origin.y-bounds.top+85},"submit":{"x":origin.x-bounds.left+100,"y":origin.y-bounds.top+150}})
        );
        let _ = std::io::stdout().flush();
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}
