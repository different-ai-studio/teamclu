//! Secrets cut out of text on its way into a stored field or a reply.

/// Strip presigned-URL query strings.
///
/// The upload handle minted by `/deploy` is a bearer credential for the app's
/// OSS object, and the daemon's build errors quote the URL they failed on. That
/// text ends up in `deployError`, which every reader of the app row can see.
pub fn redact_deploy_secrets(reason: &str) -> String {
    let mut out = String::with_capacity(reason.len());
    for (i, chunk) in reason.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        let looks_presigned = chunk.contains("Signature=")
            || chunk.contains("OSSAccessKeyId=")
            || chunk.contains("x-oss-signature");
        if looks_presigned {
            // Keep the scheme+host so the message still says where it failed.
            let head = chunk.split('?').next().unwrap_or("");
            out.push_str(head);
            out.push_str("?<redacted>");
        } else {
            out.push_str(chunk);
        }
    }
    const MAX: usize = 800;
    if out.chars().count() > MAX {
        out = out.chars().take(MAX).collect::<String>() + "…";
    }
    out
}

/// Credentials pasted into a repo address.
///
/// The server strips them before the address is stored; the clone still gets
/// the address as typed, and a clone that fails quotes it. Same rule as the
/// server's `stripUrlCredentials`: http(s) loses the whole userinfo, ssh and
/// git only the password — `git@` is part of those addresses.
pub fn redact_url_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(idx) = rest.find("://") {
        let (head, tail) = rest.split_at(idx + 3);
        let scheme: String = head[..idx]
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        out.push_str(head);
        let end = tail
            .find(|c: char| matches!(c, '/' | '?' | '#') || c.is_whitespace())
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => {
                let userinfo = &authority[..at];
                if matches!(scheme.to_ascii_lowercase().as_str(), "ssh" | "git") {
                    out.push_str(userinfo.split(':').next().unwrap_or(""));
                    if userinfo.contains(':') {
                        out.push_str(":<redacted>");
                    }
                } else {
                    out.push_str("<redacted>");
                }
                out.push_str(&authority[at..]);
            }
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_errors_do_not_carry_the_upload_credential() {
        let leaked = "Daemon build failed: PUT https://bucket.oss-cn-shenzhen.aliyuncs.com/apps/1/code.zip?OSSAccessKeyId=LTAI5t&Signature=abc%3D&Expires=1788 returned 403";
        let safe = redact_deploy_secrets(leaked);
        assert!(!safe.contains("Signature="), "{safe}");
        assert!(!safe.contains("OSSAccessKeyId="), "{safe}");
        // Still says where it failed, or the message is useless.
        assert!(
            safe.contains("bucket.oss-cn-shenzhen.aliyuncs.com/apps/1/code.zip"),
            "{safe}"
        );
        assert!(safe.contains("403"), "{safe}");
    }

    #[test]
    fn redaction_leaves_an_ordinary_message_alone_and_bounds_it() {
        let plain = "pnpm build timed out after 10 minutes";
        assert_eq!(redact_deploy_secrets(plain), plain);
        let huge = "x".repeat(5000);
        assert!(redact_deploy_secrets(&huge).chars().count() <= 801);
    }

    #[test]
    fn repo_credentials_never_reach_a_reply() {
        let text = "git clone https://x:ghp_secret@github.com/o/r.git failed";
        let safe = redact_url_credentials(text);
        assert!(!safe.contains("ghp_secret"), "{safe}");
        assert!(safe.contains("@github.com/o/r.git"), "{safe}");

        // ssh keeps the user (it is the address), loses a password.
        assert_eq!(
            redact_url_credentials("ssh://git:pw@git.example.com:2222/o/r.git"),
            "ssh://git:<redacted>@git.example.com:2222/o/r.git"
        );
        assert_eq!(
            redact_url_credentials("ssh://git@git.example.com/o/r.git"),
            "ssh://git@git.example.com/o/r.git"
        );
        assert_eq!(redact_url_credentials("no url here"), "no url here");
    }
}
