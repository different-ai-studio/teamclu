use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage,
    RegisterClassW, SetTimer, SetWindowTextW, ShowWindow, TranslateMessage, BS_PUSHBUTTON,
    CW_USEDEFAULT, HMENU, MSG, SW_HIDE, SW_SHOW, WM_COMMAND, WM_DESTROY, WM_TIMER, WNDCLASSW,
    WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};

use crate::flow::{Screen, Session};

const ALLOW: usize = 101;
const REJECT: usize = 102;
const END: usize = 103;
const REGEN: usize = 104;
const FOLDER: usize = 105;
const TIMER: usize = 1;

struct App {
    session: Session,
    // HWND is a raw pointer, which cannot live in a static Mutex. The values
    // are only used on the UI thread.
    label: usize,
    allow: usize,
    reject: usize,
    end: usize,
    regen: usize,
    folder: usize,
}

static APP: Mutex<Option<App>> = Mutex::new(None);

pub fn run(phase: &str, api: &str, journal: PathBuf) {
    unsafe {
        let class_name = wide("TeamCluSupport");
        let instance = GetModuleHandleW(std::ptr::null());
        let class = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: instance,
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&class);
        let title = wide("TeamClu 支持助手");
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            title.as_ptr(),
            WS_OVERLAPPEDWINDOW | WS_VISIBLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            520,
            320,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return;
        }
        let label = child(hwnd, "STATIC", "", 16, 16, 470, 160, 0);
        let allow = child(hwnd, "BUTTON", "允许", 16, 200, 90, 32, ALLOW);
        let reject = child(hwnd, "BUTTON", "拒绝", 116, 200, 90, 32, REJECT);
        let end = child(hwnd, "BUTTON", "结束", 216, 200, 90, 32, END);
        let regen = child(hwnd, "BUTTON", "重新生成", 316, 200, 110, 32, REGEN);
        let folder = child(hwnd, "BUTTON", "打开记录文件夹", 16, 240, 160, 32, FOLDER);
        {
            let mut guard = APP.lock().expect("support window state");
            *guard = Some(App {
                session: Session::new(phase, api, journal),
                label: raw_hwnd(label),
                allow: raw_hwnd(allow),
                reject: raw_hwnd(reject),
                end: raw_hwnd(end),
                regen: raw_hwnd(regen),
                folder: raw_hwnd(folder),
            });
        }
        start_or_offline();
        SetTimer(hwnd, TIMER, 2000, None);
        let mut message = MSG {
            ..std::mem::zeroed()
        };
        while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn start_or_offline() {
    with_app(|app| app.session.start());
}

fn with_app(update: impl FnOnce(&mut App) -> Screen) {
    let mut guard = APP.lock().expect("support window state");
    let Some(app) = guard.as_mut() else { return };
    let shown = update(app);
    apply(app, &shown);
}

fn apply(app: &App, shown: &Screen) {
    set_text(app, &shown.text);
    show_buttons(
        app,
        shown.allow,
        shown.reject,
        shown.end,
        shown.regen,
        shown.folder,
    );
}

fn set_text(app: &App, text: &str) {
    let wide_text = wide(text);
    unsafe { SetWindowTextW(hwnd(app.label), wide_text.as_ptr()) };
}

fn show_buttons(app: &App, allow: bool, reject: bool, end: bool, regen: bool, folder: bool) {
    unsafe {
        ShowWindow(hwnd(app.allow), if allow { SW_SHOW } else { SW_HIDE });
        ShowWindow(hwnd(app.reject), if reject { SW_SHOW } else { SW_HIDE });
        ShowWindow(hwnd(app.end), if end { SW_SHOW } else { SW_HIDE });
        ShowWindow(hwnd(app.regen), if regen { SW_SHOW } else { SW_HIDE });
        ShowWindow(hwnd(app.folder), if folder { SW_SHOW } else { SW_HIDE });
    }
}

fn poll() {
    let mut guard = APP.lock().expect("support window state");
    let Some(app) = guard.as_mut() else { return };
    let Some(shown) = app.session.poll() else {
        return;
    };
    apply(app, &shown);
}

fn on_allow() {
    with_app(|app| app.session.allow());
}

fn on_reject() {
    with_app(|app| app.session.reject());
}

fn on_end() {
    with_app(|app| app.session.end());
    unsafe { PostQuitMessage(0) };
}

fn on_regen() {
    with_app(|app| app.session.regen());
}

fn on_folder() {
    let path = {
        let guard = APP.lock().expect("support window state");
        guard.as_ref().map(|app| app.session.journal_dir())
    };
    let Some(path) = path else { return };
    let _ = Command::new("explorer").arg(path).spawn();
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_TIMER => poll(),
        WM_COMMAND => match (wparam & 0xffff) as usize {
            ALLOW => on_allow(),
            REJECT => on_reject(),
            END => on_end(),
            REGEN => on_regen(),
            FOLDER => on_folder(),
            _ => {}
        },
        WM_DESTROY => {
            {
                let mut guard = APP.lock().expect("support window state");
                if let Some(app) = guard.as_mut() {
                    let _ = app.session.end();
                }
            }
            PostQuitMessage(0);
        }
        _ => return DefWindowProcW(hwnd, message, wparam, lparam),
    }
    0
}

fn raw_hwnd(value: HWND) -> usize {
    value as usize
}

fn hwnd(value: usize) -> HWND {
    value as HWND
}

fn child(
    parent: HWND,
    class: &str,
    title: &str,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    id: usize,
) -> HWND {
    let class_name = wide(class);
    let text = wide(title);
    let style = WS_CHILD
        | WS_VISIBLE
        | if class == "BUTTON" {
            BS_PUSHBUTTON as u32
        } else {
            0
        };
    unsafe {
        CreateWindowExW(
            0,
            class_name.as_ptr(),
            text.as_ptr(),
            style,
            x,
            y,
            w,
            h,
            parent,
            id as HMENU,
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
