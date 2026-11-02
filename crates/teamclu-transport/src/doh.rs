//! Minimal DoH fallback for first-party MQTT / Cloud API hosts.
//!
//! Normal connects still use the system resolver. Only after a TLS/certificate
//! failure do we ask one public DoH endpoint for an A record and dial that IP
//! while keeping the original hostname for SNI / certificate checks.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use rumqttc::MqttOptions;

/// AliDNS DoH JSON endpoint — reachable on most mainland networks.
const DOH_JSON_URL: &str = "https://dns.alidns.com/resolve";

const DOH_TIMEOUT: Duration = Duration::from_secs(5);

/// True when the error text looks like a TLS certificate rejection — the
/// signature of "system DNS steered us at a hijack appliance".
pub fn looks_like_tls_cert_failure(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("certificate")
        || e.contains("cert ")
        || e.contains("ausedasendentity")
        || e.contains("unknownregistrydirectory")
        || e.contains("notvalidforname")
        || e.contains("webpk")
        || e.contains("invalidpeer")
        || (e.contains("tls") && (e.contains("error") || e.contains("fail")))
}

/// Hostname (no port, no path) from a rumqttc `broker_addr`, which is either a
/// bare host or a `ws(s)://host[:port]/path` URL.
pub fn hostname_from_broker_addr(broker_addr: &str) -> Option<String> {
    let host = if let Some((_, rest)) = broker_addr.split_once("://") {
        rest.split('/').next().unwrap_or("")
    } else {
        broker_addr
    };
    let host = host.split('@').next_back().unwrap_or(host);
    let host = if host.starts_with('[') {
        host.trim_start_matches('[')
            .split(']')
            .next()
            .unwrap_or("")
    } else {
        host.split(':').next().unwrap_or(host)
    };
    let host = host.trim();
    if host.is_empty() || host.parse::<IpAddr>().is_ok() {
        None
    } else {
        Some(host.to_string())
    }
}

/// Ask AliDNS DoH for the first A record of `host`.
pub async fn resolve_a(host: &str) -> Option<IpAddr> {
    let host = host.trim();
    if host.is_empty() || host.parse::<IpAddr>().is_ok() {
        return None;
    }

    let client = reqwest::Client::builder()
        .timeout(DOH_TIMEOUT)
        .connect_timeout(DOH_TIMEOUT)
        .use_rustls_tls()
        .https_only(true)
        .no_proxy()
        .build()
        .ok()?;

    let response = client
        .get(DOH_JSON_URL)
        .query(&[("name", host), ("type", "A")])
        .header("Accept", "application/dns-json")
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let body: DohJson = response.json().await.ok()?;
    if body.status.unwrap_or(0) != 0 {
        return None;
    }

    body.answer.into_iter().flatten().find_map(|ans| {
        if ans.r#type.unwrap_or(0) != 1 {
            return None;
        }
        ans.data?.parse::<IpAddr>().ok()
    })
}

/// If `error` looks like a cert failure and no override is set yet, resolve
/// `host` via DoH and install a TCP dial override. Returns a user-facing hint
/// when the override was applied.
pub async fn try_apply_mqtt_doh_fallback(
    options: &mut MqttOptions,
    error: &str,
) -> Option<String> {
    if options.tcp_connect_override().is_some() {
        return None;
    }
    if !looks_like_tls_cert_failure(error) {
        return None;
    }

    let (broker_addr, _) = options.broker_address();
    let host = hostname_from_broker_addr(&broker_addr)?;
    let ip = resolve_a(&host).await?;
    // Same answer as system DNS — override would not help.
    // Still install it only when we have an IP; a second attempt with the
    // same peer is cheap and keeps the branch simple.
    options.set_tcp_connect_override(ip.to_string());
    Some(format_dns_hijack_hint(error, &host, ip))
}

pub fn format_dns_hijack_hint(original_error: &str, host: &str, doh_ip: IpAddr) -> String {
    format!(
        "本地 DNS 可能被劫持（{host} 证书校验失败）。已改用备用解析 {doh_ip} 重试。原始错误: {original_error}"
    )
}

/// Hostname + port from an `http(s)://` URL. Used to pin a reqwest client via
/// [`reqwest::ClientBuilder::resolve`] after a cert failure.
pub fn hostname_and_port_from_http_url(url: &str) -> Option<(String, u16)> {
    let host = hostname_from_broker_addr(url)?;
    let (scheme, rest) = url.split_once("://")?;
    let default_port: u16 = if scheme.eq_ignore_ascii_case("http") {
        80
    } else {
        443
    };
    let authority = rest.split('/').next().unwrap_or("");
    let port = if let Some((_, port)) = authority.rsplit_once(':') {
        // Ignore IPv6 bracket forms — `hostname_from_broker_addr` already
        // rejects literal IPs, so a colon here is a port separator.
        port.parse().unwrap_or(default_port)
    } else {
        default_port
    };
    Some((host, port))
}

/// Build a one-shot Cloud API client pinned to a DoH A record for `url`.
///
/// Returns `None` when the error is not cert-like, the URL has no hostname, or
/// DoH itself fails — callers then surface the original error unchanged.
pub async fn try_http_client_after_cert_failure(
    url: &str,
    error: impl std::fmt::Display,
) -> Option<(reqwest::Client, String)> {
    // Stringify before any `.await` so the future stays `Send` (no borrowed
    // `dyn Display` across suspension points).
    let err = error.to_string();
    if !looks_like_tls_cert_failure(&err) {
        return None;
    }
    let (host, port) = hostname_and_port_from_http_url(url)?;
    let ip = resolve_a(&host).await?;
    let client = reqwest::Client::builder()
        // Match desktop/daemon Cloud API policy: HTTP/1.1 + rustls + bounds.
        .http1_only()
        .use_rustls_tls()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .resolve(&host, SocketAddr::new(ip, port))
        .build()
        .ok()?;
    Some((client, format_dns_hijack_hint(&err, &host, ip)))
}

#[derive(Debug, serde::Deserialize)]
struct DohJson {
    #[serde(rename = "Status")]
    status: Option<u16>,
    #[serde(rename = "Answer")]
    answer: Option<Vec<DohAnswer>>,
}

#[derive(Debug, serde::Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    r#type: Option<u16>,
    data: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_ca_used_as_end_entity() {
        let msg = "Websocket: IO error: invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))";
        assert!(looks_like_tls_cert_failure(msg));
    }

    #[test]
    fn ignores_auth_refusal() {
        assert!(!looks_like_tls_cert_failure(
            "Connection refused, return code: `BadUserNameOrPassword`"
        ));
    }

    #[test]
    fn parses_wss_broker_addr() {
        assert_eq!(
            hostname_from_broker_addr("wss://mqtt.service.ucar.cc/mqtt").as_deref(),
            Some("mqtt.service.ucar.cc")
        );
        assert_eq!(
            hostname_from_broker_addr("wss://mqtt.service.ucar.cc:8084/mqtt").as_deref(),
            Some("mqtt.service.ucar.cc")
        );
        assert_eq!(
            hostname_from_broker_addr("mqtt.service.ucar.cc").as_deref(),
            Some("mqtt.service.ucar.cc")
        );
        assert_eq!(hostname_from_broker_addr("1.2.3.4"), None);
        assert_eq!(hostname_from_broker_addr("wss://10.0.0.1/mqtt"), None);
    }

    #[test]
    fn parses_https_url_host_and_port() {
        assert_eq!(
            hostname_and_port_from_http_url("https://api.teamclu-dev.ucar.cc/v1/teams"),
            Some(("api.teamclu-dev.ucar.cc".into(), 443))
        );
        assert_eq!(
            hostname_and_port_from_http_url("https://api.example.com:8443/v1"),
            Some(("api.example.com".into(), 8443))
        );
        assert_eq!(
            hostname_and_port_from_http_url("http://api.example.com/v1"),
            Some(("api.example.com".into(), 80))
        );
    }
}
