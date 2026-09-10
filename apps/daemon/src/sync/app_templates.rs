//! App starter templates, compiled into the daemon binary.
//!
//! Seeding used to clone a GitHub template repo and push the result to a
//! per-app remote. Both steps needed the network, and the push needed a
//! credential; neither bought anything the deploy path uses, since
//! `app_build` builds whatever is in the local checkout. Embedding the
//! templates makes seeding a local file write, and keeps the templates in this
//! repo where they are reviewable and CI can smoke-build them.

use std::path::Path;

use include_dir::{include_dir, Dir};

// Staged by build.rs into OUT_DIR — see the comment there for why these are
// not embedded straight from `templates/`.
static STATIC_WEB: Dir<'_> = include_dir!("$OUT_DIR/app-templates/static-web");
static SLIDES: Dir<'_> = include_dir!("$OUT_DIR/app-templates/slides");
static TANSTACK_POSTGRES: Dir<'_> = include_dir!("$OUT_DIR/app-templates/tanstack-postgres");

/// The app types the platform can seed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppType {
    StaticWeb,
    Slides,
    DataApp,
}

impl AppType {
    /// Parse the wire `type` value. `fullstack_tanstack_postgres` is the legacy
    /// id for `data_app` and is still stored on apps created before the split.
    /// Anything unrecognized (including empty) falls back to `data_app`, which
    /// is what every app created before types existed actually is.
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "static_web" => Self::StaticWeb,
            "slides" => Self::Slides,
            _ => Self::DataApp,
        }
    }

    /// Human-readable name substituted into the template's `AGENTS.md`.
    pub fn display_name(self) -> &'static str {
        match self {
            Self::StaticWeb => "静态网页",
            Self::Slides => "演示材料",
            Self::DataApp => "数据操作",
        }
    }

    fn dir(self) -> &'static Dir<'static> {
        match self {
            Self::StaticWeb => &STATIC_WEB,
            Self::Slides => &SLIDES,
            Self::DataApp => &TANSTACK_POSTGRES,
        }
    }
}

/// Substitutions applied to every text file in the template.
pub struct TemplateVars<'a> {
    pub app_id: &'a str,
    pub app_name: &'a str,
    pub app_type: AppType,
}

fn substitute(text: &str, vars: &TemplateVars<'_>) -> String {
    text.replace("{{APP_NAME}}", vars.app_name)
        .replace("{{APP_ID}}", vars.app_id)
        .replace("{{APP_TYPE}}", vars.app_type.display_name())
}

/// Files whose contents get placeholder substitution. Everything else is copied
/// byte-for-byte — a lockfile or an image must not be rewritten.
fn is_substitutable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("md" | "html" | "json" | "ts" | "tsx" | "sql")
    ) && path.file_name().and_then(|n| n.to_str()) != Some("pnpm-lock.yaml")
}

/// Write the template for `vars.app_type` into `dest`, substituting placeholders.
///
/// `dest` is created if missing. Existing files are overwritten — reseeding an
/// app is expected to restore the starter files.
pub fn write_template(dest: &Path, vars: &TemplateVars<'_>) -> anyhow::Result<()> {
    std::fs::create_dir_all(dest)?;
    write_dir(vars.app_type.dir(), dest, vars)
}

fn write_dir(dir: &Dir<'_>, dest: &Path, vars: &TemplateVars<'_>) -> anyhow::Result<()> {
    for entry in dir.entries() {
        match entry {
            include_dir::DirEntry::Dir(sub) => {
                let target = dest.join(sub.path().file_name().unwrap_or_default());
                std::fs::create_dir_all(&target)?;
                write_dir(sub, &target, vars)?;
            }
            include_dir::DirEntry::File(file) => {
                let name = file.path().file_name().unwrap_or_default();
                let target = dest.join(name);
                if is_substitutable(file.path()) {
                    match std::str::from_utf8(file.contents()) {
                        Ok(text) => {
                            std::fs::write(&target, substitute(text, vars))?;
                            continue;
                        }
                        Err(_) => { /* not text after all — fall through to raw copy */ }
                    }
                }
                std::fs::write(&target, file.contents())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_template_ignores_the_daemon_runtime_files() {
        // The deploy commits the workdir, so a template that does not ignore
        // these seeds an app whose first deploy pushes machine-local state into
        // its own repo. The list lives in `app_git`; this is the drift guard.
        for app_type in [AppType::StaticWeb, AppType::Slides, AppType::DataApp] {
            let gitignore = app_type
                .dir()
                .get_file(".gitignore")
                .unwrap_or_else(|| panic!("{app_type:?} template has no .gitignore"))
                .contents_utf8()
                .expect("utf-8 .gitignore");
            for entry in crate::sync::app_git::runtime_exclude_entries("teamclu") {
                assert!(
                    gitignore.lines().any(|line| line.trim() == entry),
                    "{app_type:?} template does not ignore {entry}"
                );
            }
        }
    }

    use super::*;

    #[test]
    fn parses_types_and_falls_back_to_data_app() {
        assert_eq!(AppType::parse("static_web"), AppType::StaticWeb);
        assert_eq!(AppType::parse(" slides "), AppType::Slides);
        assert_eq!(AppType::parse("data_app"), AppType::DataApp);
        // Legacy id stored on apps created before the split.
        assert_eq!(
            AppType::parse("fullstack_tanstack_postgres"),
            AppType::DataApp
        );
        assert_eq!(AppType::parse(""), AppType::DataApp);
        assert_eq!(AppType::parse("nonsense"), AppType::DataApp);
    }

    fn seed(app_type: AppType) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        write_template(
            tmp.path(),
            &TemplateVars {
                app_id: "app-123",
                app_name: "我的应用",
                app_type,
            },
        )
        .unwrap();
        tmp
    }

    #[test]
    fn every_template_ships_the_build_contract_and_agents_md() {
        for t in [AppType::StaticWeb, AppType::Slides, AppType::DataApp] {
            let tmp = seed(t);
            let root = tmp.path();
            assert!(root.join("package.json").is_file(), "{t:?}: package.json");
            assert!(
                root.join("pnpm-lock.yaml").is_file(),
                "{t:?}: committed lockfile"
            );
            assert!(root.join("AGENTS.md").is_file(), "{t:?}: AGENTS.md");
            assert!(
                root.join("teamclu.app.json").is_file(),
                "{t:?}: teamclu.app.json"
            );
        }
    }

    #[test]
    fn seeded_manifest_passes_read_app_declaration() {
        for t in [AppType::StaticWeb, AppType::Slides, AppType::DataApp] {
            let tmp = seed(t);
            let declaration =
                crate::sync::app_build::read_app_declaration(tmp.path()).unwrap_or_else(|e| {
                    panic!("{t:?}: seeded teamclu.app.json must parse: {e}")
                });
            assert_eq!(declaration.build.kind, "node");
            assert_eq!(declaration.build.output, ".output");
            assert_eq!(
                declaration.start.command,
                Some(vec!["/opt/nodejs20/bin/node".to_string()])
            );
            assert_eq!(
                declaration.start.args,
                Some(vec!["server/index.mjs".to_string()])
            );
            assert_eq!(declaration.start.port, 9000);
        }
    }

    #[test]
    fn placeholders_are_substituted_in_agents_md() {
        let tmp = seed(AppType::Slides);
        let agents = std::fs::read_to_string(tmp.path().join("AGENTS.md")).unwrap();
        assert!(agents.contains("我的应用"), "app name substituted");
        assert!(agents.contains("app-123"), "app id substituted");
        assert!(!agents.contains("{{"), "no placeholder left: {agents}");
    }

    #[test]
    fn nested_directories_are_written() {
        let tmp = seed(AppType::Slides);
        assert!(tmp.path().join("public/index.html").is_file());
        let html = std::fs::read_to_string(tmp.path().join("public/index.html")).unwrap();
        assert!(html.contains("我的应用"));
        assert!(!html.contains("{{APP_NAME}}"));
    }

    #[test]
    fn no_build_output_or_dependencies_are_embedded() {
        // build.rs filters these out; without it a stray `pnpm install` in the
        // template directory would compile 6 MB of node_modules into the daemon
        // and seed it into every app.
        for t in [AppType::StaticWeb, AppType::Slides, AppType::DataApp] {
            let tmp = seed(t);
            for junk in ["node_modules", ".output", "dist", ".nitro"] {
                assert!(
                    !tmp.path().join(junk).exists(),
                    "{t:?}: {junk} must not ship in the template"
                );
            }
        }
    }

    #[test]
    fn the_lockfile_is_copied_verbatim() {
        // A lockfile has no placeholders, but it must never go through the
        // string path either — pnpm rejects any byte-level surprise.
        let tmp = seed(AppType::Slides);
        let lock = std::fs::read(tmp.path().join("pnpm-lock.yaml")).unwrap();
        assert_eq!(
            lock,
            SLIDES.get_file("pnpm-lock.yaml").unwrap().contents(),
            "lockfile copied byte-for-byte"
        );
    }

    #[test]
    fn the_dev_server_finds_the_site_in_both_layouts() {
        // `server.mjs` runs from two places: in the artifact it is
        // `.output/server/index.mjs` with the site at `../public`, and under
        // `pnpm dev` it runs in place at the app root with the site at
        // `./public`. It used to resolve `../public` unconditionally, which at
        // the app root points OUTSIDE the app — at the directory holding every
        // app — so `pnpm dev` served a path that does not exist and answered
        // 404 to everything, in every static site app. Nothing reported it: an
        // empty preview reads as "I have not written the page yet".
        for t in [AppType::StaticWeb, AppType::Slides] {
            let tmp = seed(t);
            let server = std::fs::read_to_string(tmp.path().join("server.mjs")).unwrap();
            assert!(
                !server.contains("new URL('../public/', import.meta.url)"),
                "{t:?}: server.mjs resolves ../public unconditionally, which breaks `pnpm dev`"
            );
            assert!(
                server.contains("existsSync"),
                "{t:?}: server.mjs must pick its root by looking for the site"
            );
        }
    }
}
