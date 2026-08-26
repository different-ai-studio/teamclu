//! Native application menu bar (macOS TeamClu / File / Edit / …).
//!
//! Replaces Tauri's default menu so we can:
//! - use the product brand name (not Cargo package `teamclu`) in About/Hide/Quit
//! - add Settings… with ⌘, that opens the in-app Settings dialog
//! - render the bar in the language the user picked in Settings
//!
//! That last one is not free. `muda::PredefinedMenuItemType::text` is a
//! hardcoded English table on *every* platform (`&Copy`, `Cu&t`, `Select &All`,
//! `&Exit`, …), so passing `None` for an item's text pins it to English no
//! matter what the OS or the app is set to. Every label therefore has to be
//! supplied explicitly, which is what `MenuLabels` carries.
//!
//! The frontend owns the translations (`menu.*` in the locale files) and pushes
//! a full set through `update_app_menu_labels` on boot and on every language
//! change. The EN/ZH tables below only cover cold start, before any JS has run.

use serde::Deserialize;
use tauri::{
    menu::{
        AboutMetadata, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    AppHandle, Emitter, Manager,
};

use crate::branding;
use crate::commands::prefers_zh_locale;

pub const APP_SETTINGS_ID: &str = "app_settings";
pub const OPEN_SETTINGS_EVENT: &str = "open-app-settings";

/// Every string the menu bar shows, minus the brand name this module splices
/// into About / Hide / Quit.
///
/// Field names mirror the `menu.*` keys in `packages/app/src/locales/*.json`;
/// the frontend sends this whole struct as one camelCase object.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuLabels {
    // Submenu titles.
    pub file: String,
    pub edit: String,
    pub view: String,
    pub window: String,
    pub help: String,
    // Items.
    pub settings: String,
    pub undo: String,
    pub redo: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
    pub minimize: String,
    /// Windows / Linux wording for the Window submenu.
    pub maximize: String,
    /// macOS wording for the same item — AppKit calls it Zoom, not Maximize.
    pub zoom: String,
    pub fullscreen: String,
    /// Windows / Linux File submenu.
    pub close: String,
    /// macOS, where the item closes the window rather than the document.
    pub close_window: String,
    pub about: String,
    pub hide: String,
    pub hide_others: String,
    pub services: String,
    pub quit: String,
}

impl MenuLabels {
    /// Mnemonics (`&`) match what muda ships, so the Alt-key shortcuts Windows
    /// users have today survive the switch to explicit labels.
    pub fn en() -> Self {
        Self {
            file: "&File".into(),
            edit: "&Edit".into(),
            view: "&View".into(),
            window: "&Window".into(),
            help: "&Help".into(),
            settings: "Settings…".into(),
            undo: "Undo".into(),
            redo: "Redo".into(),
            cut: "Cu&t".into(),
            copy: "&Copy".into(),
            paste: "&Paste".into(),
            select_all: "Select &All".into(),
            minimize: "&Minimize".into(),
            maximize: "Ma&ximize".into(),
            zoom: "Zoom".into(),
            fullscreen: "Toggle Full Screen".into(),
            close: "&Close".into(),
            close_window: "C&lose Window".into(),
            about: "About".into(),
            hide: "Hide".into(),
            hide_others: "Hide Others".into(),
            services: "Services".into(),
            quit: "Quit".into(),
        }
    }

    /// Only the top-level titles carry a mnemonic, in the `文件(&F)` form
    /// Windows uses for CJK menus — that is where Alt navigation starts, and
    /// tacking `(&X)` onto every item makes the open menu hard to read.
    pub fn zh() -> Self {
        Self {
            file: "文件(&F)".into(),
            edit: "编辑(&E)".into(),
            view: "视图(&V)".into(),
            window: "窗口(&W)".into(),
            help: "帮助(&H)".into(),
            settings: "设置…".into(),
            undo: "撤销".into(),
            redo: "重做".into(),
            cut: "剪切".into(),
            copy: "复制".into(),
            paste: "粘贴".into(),
            select_all: "全选".into(),
            minimize: "最小化".into(),
            maximize: "最大化".into(),
            zoom: "缩放".into(),
            fullscreen: "切换全屏".into(),
            close: "关闭".into(),
            close_window: "关闭窗口".into(),
            about: "关于".into(),
            hide: "隐藏".into(),
            hide_others: "隐藏其他".into(),
            services: "服务".into(),
            quit: "退出".into(),
        }
    }

    /// Cold-start labels, picked from the OS locale because the persisted UI
    /// language lives in the webview's localStorage and no JS has run yet.
    pub fn for_os_locale() -> Self {
        if prefers_zh_locale() {
            Self::zh()
        } else {
            Self::en()
        }
    }
}

/// Windows spells a CJK mnemonic as `文件(&F)`; muda's macOS backend strips the
/// `&` and nothing else, which would leave a stray `文件(F)` in the menu bar.
/// Drop the whole group there. English labels (`&File`) have no group and pass
/// through untouched.
#[cfg(target_os = "macos")]
fn label(text: &str) -> String {
    let Some(head) = text.strip_suffix(')') else {
        return text.to_string();
    };
    match head.rfind("(&") {
        Some(i) if head[i + 2..].chars().count() == 1 => head[..i].to_string(),
        _ => text.to_string(),
    }
}

#[cfg(not(target_os = "macos"))]
fn label(text: &str) -> String {
    text.to_string()
}

/// Build the app-wide menu and install it.
///
/// Called again with a fresh `labels` whenever the UI language changes. Tauri's
/// `set_menu` removes the previous menu first, so re-installing is the
/// supported way to relabel — and it beats holding a `set_text` handle for each
/// of the ~20 items, half of which only exist behind a `#[cfg]`.
pub fn install_app_menu(app: &AppHandle, labels: &MenuLabels) -> tauri::Result<()> {
    let brand = branding::brand_name(app.config().product_name.as_deref());
    let version = app.package_info().version.to_string();
    let about_metadata = AboutMetadata {
        name: Some(brand.clone()),
        version: Some(version),
        copyright: app.config().bundle.copyright.clone(),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let about_brand = label(&format!("{} {brand}", labels.about));

    let settings = MenuItemBuilder::with_id(APP_SETTINGS_ID, label(&labels.settings))
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // Linux/BSD get neither the File submenu nor the macOS app submenu, so
    // nothing there hosts Settings…. Keep one builder rather than fanning it
    // out per platform, and mark the binding used on those targets.
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    let _ = &settings;

    #[cfg(target_os = "macos")]
    let maximize_label = label(&labels.zoom);
    #[cfg(not(target_os = "macos"))]
    let maximize_label = label(&labels.maximize);

    #[cfg(target_os = "macos")]
    let close_label = label(&labels.close_window);
    #[cfg(not(target_os = "macos"))]
    let close_label = label(&labels.close);

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        label(&labels.window),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&label(&labels.minimize)))?,
            &PredefinedMenuItem::maximize(app, Some(&maximize_label))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some(&close_label))?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        label(&labels.help),
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, Some(&about_brand), Some(about_metadata.clone()))?,
        ],
    )?;

    #[cfg(target_os = "macos")]
    let app_submenu = Submenu::with_items(
        app,
        &brand,
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&about_brand), Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(&label(&labels.services)))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&label(&format!("{} {brand}", labels.hide))))?,
            &PredefinedMenuItem::hide_others(app, Some(&label(&labels.hide_others)))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(&label(&format!("{} {brand}", labels.quit))))?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &app_submenu,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app,
                label(&labels.file),
                true,
                &[
                    #[cfg(not(target_os = "macos"))]
                    &settings,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, Some(&close_label))?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(
                        app,
                        Some(&label(&format!("{} {brand}", labels.quit))),
                    )?,
                ],
            )?,
            &Submenu::with_items(
                app,
                label(&labels.edit),
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some(&label(&labels.undo)))?,
                    &PredefinedMenuItem::redo(app, Some(&label(&labels.redo)))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some(&label(&labels.cut)))?,
                    &PredefinedMenuItem::copy(app, Some(&label(&labels.copy)))?,
                    &PredefinedMenuItem::paste(app, Some(&label(&labels.paste)))?,
                    &PredefinedMenuItem::select_all(app, Some(&label(&labels.select_all)))?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                label(&labels.view),
                true,
                &[&PredefinedMenuItem::fullscreen(
                    app,
                    Some(&label(&labels.fullscreen)),
                )?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )?;

    let _ = app.set_menu(menu)?;
    Ok(())
}

/// Show the main window and ask the frontend to open Settings.
pub fn open_app_settings(app: &AppHandle) {
    let state = app.state::<super::window_chrome::MainWindowState>();
    super::window_chrome::show_main_window(app.clone(), state);
    if let Err(e) = app.emit(OPEN_SETTINGS_EVENT, ()) {
        eprintln!("[app-menu] emit {OPEN_SETTINGS_EVENT}: {e}");
    }
}

/// Rebuild the menu bar in the UI's current language.
#[tauri::command]
pub fn update_app_menu_labels(app: AppHandle, labels: MenuLabels) -> Result<(), String> {
    install_app_menu(&app, &labels).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend sends whatever `menu.*` holds; a missing key would silently
    /// drop the whole payload, so the two tables must stay field-complete.
    #[test]
    fn label_tables_are_distinct_and_filled() {
        let en = MenuLabels::en();
        let zh = MenuLabels::zh();
        assert_ne!(en.file, zh.file);
        assert_ne!(en.quit, zh.quit);
        assert!(!zh.select_all.is_empty());
        assert!(!en.select_all.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_drops_cjk_mnemonic_groups() {
        assert_eq!(label("文件(&F)"), "文件");
        assert_eq!(label("&File"), "&File");
        // Not a mnemonic — a parenthesised word must survive.
        assert_eq!(label("设置(高级)"), "设置(高级)");
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn other_platforms_keep_mnemonics_verbatim() {
        assert_eq!(label("文件(&F)"), "文件(&F)");
        assert_eq!(label("&File"), "&File");
    }
}
