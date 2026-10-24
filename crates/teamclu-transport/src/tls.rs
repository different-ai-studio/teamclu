//! Root-certificate store for MQTT TLS transports.
//!
//! rumqttc's `TlsConfiguration::default()` — which both
//! `Transport::wss_with_default_config()` and `tls_with_default_config()` call
//! through — is
//!
//! ```ignore
//! for cert in load_native_certs().expect("could not load platform certs") {
//!     root_cert_store.add(cert).unwrap();
//! }
//! ```
//!
//! Two panics, not errors: one if the platform store cannot be read at all, one
//! per root that fails to parse. On macOS a transient keychain read returns
//! `code: -36, "I/O error."` and took the whole desktop app down with it
//! (Sentry TEAMCLU-2G / TEAMCLU-20, both `fatal`, both production). The
//! daemon calls the same two constructors and had the same latent crash.
//!
//! Build the store here instead: prefer the platform roots, tolerate individual
//! bad ones, fall back to the bundled webpki roots when the platform store is
//! unusable, and never panic. This lives in the shared crate so the desktop app
//! and the daemon cannot drift apart on it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use rumqttc::TlsConfiguration;
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};

/// Cached only on the platform-roots path. A fallback build is deliberately
/// left uncached: a transient keychain failure must not pin the process to the
/// bundled roots for the rest of its life, because a corporate CA that only
/// exists in the system store would stop verifying until the next restart.
static NATIVE_CONFIG: OnceLock<TlsConfiguration> = OnceLock::new();
/// The fallback is retried per connection attempt; the log line is not.
static FALLBACK_LOGGED: AtomicBool = AtomicBool::new(false);

/// A resolved MQTT TLS configuration.
pub struct ResolvedTlsConfig {
    pub config: TlsConfiguration,
    /// `Some(reason)` when the platform store was unusable and the bundled
    /// webpki roots were substituted. Callers with telemetry should report it;
    /// this module has already logged it.
    pub fallback_reason: Option<String>,
}

/// The TLS config every MQTT transport should use. Replaces
/// `TlsConfiguration::default()`.
pub fn default_tls_config() -> ResolvedTlsConfig {
    if let Some(config) = NATIVE_CONFIG.get() {
        return ResolvedTlsConfig {
            config: config.clone(),
            fallback_reason: None,
        };
    }
    match native_root_store() {
        Ok(roots) => ResolvedTlsConfig {
            config: NATIVE_CONFIG
                .get_or_init(|| config_from_roots(roots))
                .clone(),
            fallback_reason: None,
        },
        Err(reason) => {
            log_fallback(&reason);
            ResolvedTlsConfig {
                config: config_from_roots(webpki_root_store()),
                fallback_reason: Some(reason),
            }
        }
    }
}

fn native_root_store() -> Result<RootCertStore, String> {
    store_from_native_result(rustls_native_certs::load_native_certs())
}

fn store_from_native_result(
    result: rustls_native_certs::CertificateResult,
) -> Result<RootCertStore, String> {
    // 0.8 can return usable roots alongside load errors. Keep those roots;
    // only an unusable store should trigger the uncached webpki fallback.
    store_from_certs(result.certs).map_err(|reason| {
        if result.errors.is_empty() {
            reason
        } else {
            format!("{reason}; load_native_certs errors: {:?}", result.errors)
        }
    })
}

/// `Err` when the platform store yields nothing usable. An empty store is a
/// failure, not a success: `ClientConfig` accepts one happily and then every
/// handshake fails with `UnknownIssuer`, which is far harder to trace back here
/// than falling back is.
fn store_from_certs(certs: Vec<CertificateDer<'static>>) -> Result<RootCertStore, String> {
    let offered = certs.len();
    let mut store = RootCertStore::empty();
    for cert in certs {
        // rumqttc unwraps this. One unparseable root in a keychain is no reason
        // to lose the other few hundred.
        let _ = store.add(cert);
    }
    if store.is_empty() {
        return Err(format!(
            "platform store held no usable roots ({offered} offered)"
        ));
    }
    Ok(store)
}

fn webpki_root_store() -> RootCertStore {
    RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    }
}

fn config_from_roots(roots: RootCertStore) -> TlsConfiguration {
    TlsConfiguration::Rustls(Arc::new(
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}

fn log_fallback(reason: &str) {
    if FALLBACK_LOGGED.swap(true, Ordering::Relaxed) {
        return;
    }
    tracing::warn!("[mqtt-tls] {reason}; falling back to bundled webpki roots");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_native_load_reports_failure_without_panicking() {
        let result = rustls_native_certs::CertificateResult::default();
        assert!(store_from_native_result(result)
            .unwrap_err()
            .contains("no usable roots"));
    }

    #[test]
    fn native_roots_survive_one_unparseable_certificate() {
        let certificate = rcgen::generate_simple_self_signed(vec!["mqtt.test".into()]).unwrap();
        let mut result = rustls_native_certs::CertificateResult::default();
        result.certs = vec![
            CertificateDer::from(vec![0]),
            certificate.cert.der().clone(),
        ];
        assert_eq!(store_from_native_result(result).unwrap().len(), 1);
    }

    // Exercise rustls itself: a dependency migration must not turn either
    // certificate trust or hostname verification into an accept-all callback.
    fn handshake(trust_server: bool, hostname: &'static str) -> Result<(), rustls::Error> {
        use rustls::pki_types::PrivatePkcs8KeyDer;
        use std::io::Cursor;
        let certificate = rcgen::generate_simple_self_signed(vec!["mqtt.test".into()]).unwrap();
        let mut roots = RootCertStore::empty();
        if trust_server {
            roots.add(certificate.cert.der().clone()).unwrap();
        }
        let TlsConfiguration::Rustls(client) = config_from_roots(roots) else {
            panic!("MQTT must retain rustls");
        };
        let server = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![certificate.cert.der().clone()],
            PrivatePkcs8KeyDer::from(certificate.signing_key.serialize_der()).into(),
        )
        .unwrap();
        let mut client =
            rustls::ClientConnection::new(client, hostname.try_into().unwrap()).unwrap();
        let mut server = rustls::ServerConnection::new(Arc::new(server)).unwrap();
        for _ in 0..10 {
            let mut bytes = Vec::new();
            client.write_tls(&mut bytes).unwrap();
            server.read_tls(&mut Cursor::new(bytes)).unwrap();
            server.process_new_packets()?;
            let mut bytes = Vec::new();
            server.write_tls(&mut bytes).unwrap();
            client.read_tls(&mut Cursor::new(bytes)).unwrap();
            client.process_new_packets()?;
            if !client.is_handshaking() && !server.is_handshaking() {
                return Ok(());
            }
        }
        panic!("TLS handshake did not complete");
    }

    #[test]
    fn trusted_mqtt_certificate_completes_handshake() {
        handshake(true, "mqtt.test").unwrap();
    }

    #[test]
    fn mqtt_tls_rejects_untrusted_certificates() {
        assert!(matches!(
            handshake(false, "mqtt.test"),
            Err(rustls::Error::InvalidCertificate(_))
        ));
    }

    #[test]
    fn mqtt_tls_rejects_wrong_hostname() {
        assert!(matches!(
            handshake(true, "wrong.test"),
            Err(rustls::Error::InvalidCertificate(_))
        ));
    }

    fn is_rustls(config: &TlsConfiguration) -> bool {
        matches!(config, TlsConfiguration::Rustls(_))
    }

    #[test]
    fn empty_platform_store_is_an_error_not_an_empty_config() {
        let err = store_from_certs(Vec::new()).unwrap_err();
        assert!(err.contains("0 offered"), "{err}");
    }

    #[test]
    fn unparseable_roots_degrade_to_an_error_instead_of_panicking() {
        // The exact input that makes rumqttc's `.unwrap()` abort the process.
        let garbage = vec![CertificateDer::from(vec![0x00, 0x01, 0x02])];
        assert!(store_from_certs(garbage).is_err());
    }

    #[test]
    fn bundled_roots_are_a_usable_fallback() {
        let store = webpki_root_store();
        assert!(!store.is_empty());
        assert!(is_rustls(&config_from_roots(store)));
    }

    #[test]
    fn default_config_never_panics() {
        let resolved = default_tls_config();
        assert!(is_rustls(&resolved.config));
    }
}
