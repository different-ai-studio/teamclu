use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, sel, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSButton, NSTextField,
    NSWindow, NSWindowDelegate, NSWindowStyleMask,
};
use objc2_foundation::{
    NSNotification, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSTimer,
};

use crate::flow::{Screen, Session};

struct Ui {
    label: usize,
    allow: usize,
    reject: usize,
    end: usize,
    regen: usize,
    folder: usize,
}

struct State {
    session: Session,
    ui: Ui,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    struct SupportActions;

    impl SupportActions {
        #[unsafe(method(onAllow:))]
        fn on_allow(&self, _sender: Option<&AnyObject>) {
            handle_allow();
        }

        #[unsafe(method(onReject:))]
        fn on_reject(&self, _sender: Option<&AnyObject>) {
            handle_reject();
        }

        #[unsafe(method(onEnd:))]
        fn on_end(&self, _sender: Option<&AnyObject>) {
            handle_end(self.mtm());
        }

        #[unsafe(method(onRegen:))]
        fn on_regen(&self, _sender: Option<&AnyObject>) {
            handle_regen();
        }

        #[unsafe(method(onFolder:))]
        fn on_folder(&self, _sender: Option<&AnyObject>) {
            handle_folder();
        }

        #[unsafe(method(onStart:))]
        fn on_start(&self, _timer: Option<&AnyObject>) {
            handle_start();
        }

        #[unsafe(method(onTick:))]
        fn on_tick(&self, _timer: Option<&AnyObject>) {
            handle_poll();
        }
    }

    unsafe impl NSObjectProtocol for SupportActions {}

    unsafe impl NSWindowDelegate for SupportActions {
        #[allow(non_snake_case)]
        #[unsafe(method(windowWillClose:))]
        fn windowWillClose(&self, _notification: &NSNotification) {
            handle_close(self.mtm());
        }
    }
);

impl SupportActions {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

pub fn run(phase: &str, api: &str, journal: PathBuf) {
    let mtm = MainThreadMarker::new().expect("support helper runs on the main thread");
    let app = NSApplication::sharedApplication(mtm);
    let _ = app.setActivationPolicy(NSApplicationActivationPolicy::Regular);

    let actions = SupportActions::new(mtm);
    let target: &AnyObject = &actions;

    let label = NSTextField::wrappingLabelWithString(&NSString::from_str(""), mtm);
    let allow = button("允许", &actions, sel!(onAllow:), mtm);
    let reject = button("拒绝", &actions, sel!(onReject:), mtm);
    let end = button("结束", &actions, sel!(onEnd:), mtm);
    let regen = button("重新生成", &actions, sel!(onRegen:), mtm);
    let folder = button("打开记录文件夹", &actions, sel!(onFolder:), mtm);

    label.setStringValue(&NSString::from_str("正在连接…"));
    label.setFrame(rect(20.0, 110.0, 480.0, 160.0));
    allow.setFrame(rect(20.0, 24.0, 90.0, 32.0));
    reject.setFrame(rect(120.0, 24.0, 90.0, 32.0));
    end.setFrame(rect(220.0, 24.0, 90.0, 32.0));
    regen.setFrame(rect(320.0, 24.0, 110.0, 32.0));
    folder.setFrame(rect(20.0, 64.0, 160.0, 32.0));
    allow.setHidden(true);
    reject.setHidden(true);
    end.setHidden(true);
    regen.setHidden(true);
    folder.setHidden(true);

    let style =
        NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Miniaturizable;
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect(240.0, 180.0, 520.0, 300.0),
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("TeamClu 支持助手"));
    window.setDelegate(Some(ProtocolObject::from_ref(&*actions)));
    if let Some(content) = window.contentView() {
        content.addSubview(&label);
        content.addSubview(&allow);
        content.addSubview(&reject);
        content.addSubview(&end);
        content.addSubview(&regen);
        content.addSubview(&folder);
    }

    {
        let mut guard = STATE.lock().expect("support window state");
        *guard = Some(State {
            session: Session::new(phase, api, journal),
            ui: Ui {
                label: retained_ptr(&label),
                allow: retained_ptr(&allow),
                reject: retained_ptr(&reject),
                end: retained_ptr(&end),
                regen: retained_ptr(&regen),
                folder: retained_ptr(&folder),
            },
        });
    }
    window.makeKeyAndOrderFront(None);
    #[allow(deprecated)]
    {
        // `activate` is newer. This call still brings the window forward on the
        // macOS versions the desktop app supports.
        app.activateIgnoringOtherApps(true);
    }
    // Start after the run loop is up so the window can paint during the request.
    let start_timer = unsafe {
        NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
            0.05,
            target,
            sel!(onStart:),
            None,
            false,
        )
    };
    let timer = unsafe {
        NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
            2.0,
            target,
            sel!(onTick:),
            None,
            true,
        )
    };
    let _keep = (
        actions,
        label,
        allow,
        reject,
        end,
        regen,
        folder,
        start_timer,
        timer,
        window,
    );
    app.run();
}

fn button(
    title: &str,
    target: &SupportActions,
    action: objc2::runtime::Sel,
    mtm: MainThreadMarker,
) -> Retained<NSButton> {
    unsafe {
        NSButton::buttonWithTitle_target_action(
            &NSString::from_str(title),
            Some(target),
            Some(action),
            mtm,
        )
    }
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
    NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
}

fn retained_ptr<T: objc2::Message>(value: &Retained<T>) -> usize {
    Retained::as_ptr(value) as usize
}

fn apply(ui: &Ui, shown: &Screen) {
    unsafe {
        let label = &*(ui.label as *const NSTextField);
        label.setStringValue(&NSString::from_str(&shown.text));
        let allow = &*(ui.allow as *const NSButton);
        let reject = &*(ui.reject as *const NSButton);
        let end = &*(ui.end as *const NSButton);
        let regen = &*(ui.regen as *const NSButton);
        let folder = &*(ui.folder as *const NSButton);
        allow.setHidden(!shown.allow);
        reject.setHidden(!shown.reject);
        end.setHidden(!shown.end);
        regen.setHidden(!shown.regen);
        folder.setHidden(!shown.folder);
    }
}

fn with_state(update: impl FnOnce(&mut State) -> Screen) {
    let mut guard = STATE.lock().expect("support window state");
    let Some(state) = guard.as_mut() else { return };
    let shown = update(state);
    apply(&state.ui, &shown);
}

fn handle_start() {
    with_state(|state| state.session.start());
}

fn handle_poll() {
    let mut guard = STATE.lock().expect("support window state");
    let Some(state) = guard.as_mut() else { return };
    let Some(shown) = state.session.poll() else {
        return;
    };
    apply(&state.ui, &shown);
}

fn handle_allow() {
    with_state(|state| state.session.allow());
}

fn handle_reject() {
    with_state(|state| state.session.reject());
}

fn handle_end(mtm: MainThreadMarker) {
    with_state(|state| state.session.end());
    NSApplication::sharedApplication(mtm).stop(None);
}

fn handle_regen() {
    with_state(|state| state.session.regen());
}

fn handle_folder() {
    let dir = {
        let guard = STATE.lock().expect("support window state");
        guard.as_ref().map(|state| state.session.journal_dir())
    };
    let Some(dir) = dir else { return };
    let _ = Command::new("open").arg(dir).spawn();
}

fn handle_close(mtm: MainThreadMarker) {
    with_state(|state| state.session.end());
    NSApplication::sharedApplication(mtm).stop(None);
}
