//! Page templates for the knowledge vault's `create` action, and the date stamp
//! the knowledge handlers write into pages.
//!
//! There is deliberately no vault scaffold any more: team knowledge grows as a
//! Wiki compiled from `documents/`, so nothing lays down a fixed directory
//! tree. Teams that ran the old scaffold keep what it wrote.

/// The `_index.md` (domain MOC) template, for `create` with `template: domain-index`.
pub fn domain_index_template() -> &'static str {
    include_str!("../../assets/knowledge-templates/_index.md")
}

/// Today as `YYYY-MM-DD` (local). Exposed for the knowledge MCP handlers
/// (template stamping in `daemon::server::knowledge`).
pub(crate) fn today_iso() -> String {
    // Local date, not UTC. These stamps are read by people — a salvage filename
    // and an `updated:` line — and UTC files anything done before 08:00 in
    // China under yesterday. `chrono` is already a direct dependency of this
    // crate (`Cargo.toml`), which the hand-rolled civil-from-days algorithm
    // this replaces was written to avoid.
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_stamp_is_iso() {
        let d = today_iso();
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
        assert_eq!(&d[7..8], "-");
    }
}
