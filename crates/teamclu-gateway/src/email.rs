use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, RwLock};

use crate::email_config::{
    EmailConfig, EmailGatewayStatus, EmailGatewayStatusResponse, EmailProvider,
};
use crate::email_db::EmailDb;
use crate::{AgentHandle, ChannelStore};

/// Maximum number of processed message UIDs to keep in the dedup set.
/// With UID watermark, this set only grows within a single gateway session,
/// so a small value is sufficient.
const MAX_PROCESSED_UIDS: usize = 500;

/// IMAP IDLE timeout in seconds (renew every 25 minutes, RFC recommends < 29 min)
const IDLE_TIMEOUT_SECS: u64 = 25 * 60;

/// Polling interval when IDLE is not supported (e.g. 163.com Coremail)
const POLL_INTERVAL_SECS: u64 = 30;

/// Get the current highest UID in the mailbox (the "high water mark").
/// All messages with UID > this value are considered new.
fn get_max_uid(
    session: &mut imap::Session<impl std::io::Read + std::io::Write>,
) -> Result<u32, String> {
    let _ = session.noop();
    // Search ALL messages and take the max UID. For large mailboxes this is
    // still a server-side operation that just returns UID numbers (no bodies).
    // Alternatively use "*" UID fetch but "UID SEARCH ALL" is more portable.
    match session.uid_search("ALL") {
        Ok(uids) => Ok(uids.into_iter().max().unwrap_or(0)),
        Err(e) => {
            // Fallback: try RECENT or just return 0 (process nothing old)
            println!("[Email] UID SEARCH ALL failed: {}, using 0 as baseline", e);
            Ok(0)
        }
    }
}

/// Search for new messages that arrived after the given UID water mark.
/// Uses "UID <start>:*" which is very efficient - only returns UIDs above the mark.
/// Also filters UNSEEN to avoid re-processing read messages in the same range.
fn search_new_messages_since_uid(
    session: &mut imap::Session<impl std::io::Read + std::io::Write>,
    since_uid: u32,
) -> Result<Vec<u32>, String> {
    let _ = session.noop();

    // UID range query: fetch UIDs greater than since_uid
    // IMAP UID ranges are inclusive, so we use since_uid+1:*
    let start = since_uid + 1;
    let query = format!("UID {}:*", start);

    match session.uid_search(&query) {
        Ok(uids) => {
            // Filter out the since_uid itself (IMAP may return it if it's the max)
            let new_uids: Vec<u32> = uids.into_iter().filter(|&uid| uid > since_uid).collect();
            Ok(new_uids)
        }
        Err(e) => {
            // Fallback to UNSEEN if UID range search fails
            println!(
                "[Email] UID range search failed: {}, falling back to UNSEEN",
                e
            );
            match session.uid_search("UNSEEN") {
                Ok(uids) => {
                    let new_uids: Vec<u32> =
                        uids.into_iter().filter(|&uid| uid > since_uid).collect();
                    Ok(new_uids)
                }
                Err(e2) => Err(format!("Both UID range and UNSEEN search failed: {}", e2)),
            }
        }
    }
}

/// Gmail IMAP server
const GMAIL_IMAP_SERVER: &str = "imap.gmail.com";
const GMAIL_IMAP_PORT: u16 = 993;

/// Gmail SMTP server
const GMAIL_SMTP_SERVER: &str = "smtp.gmail.com";
const GMAIL_SMTP_PORT: u16 = 587;

/// Gmail OAuth2 scopes
const GMAIL_SCOPE: &str = "https://mail.google.com/";

/// Token file name stored in workspace TEAMCLU_DIR
const TOKEN_FILE_NAME: &str = "email-tokens.json";

// ==================== OAuth2 Flow Delegate ====================

/// Type-erased callback for delivering the auth URL to the caller (e.g. so
/// the UI can display it for manual copy/paste if `webbrowser::open` fails).
pub type AuthUrlCallback = Box<dyn Fn(&str) + Send + Sync + 'static>;

/// Custom `InstalledFlowDelegate` that opens the auth URL in the system
/// browser AND forwards it to a caller-provided callback. The default
/// delegate from yup-oauth2 only `println!`s the URL to stdout, which is
/// invisible inside a packaged Tauri desktop app.
struct BrowserOpenerDelegate {
    on_url: AuthUrlCallback,
}

impl yup_oauth2::authenticator_delegate::InstalledFlowDelegate for BrowserOpenerDelegate {
    fn present_user_url<'a>(
        &'a self,
        url: &'a str,
        _need_code: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>
    {
        Box::pin(async move {
            (self.on_url)(url);
            // Best-effort browser open. If it fails (no default browser, sandbox,
            // etc.), the URL is still surfaced via on_url for manual copy/paste.
            if let Err(e) = webbrowser::open(url) {
                eprintln!("[Gmail OAuth] Failed to open browser: {}", e);
            }
            // HTTPRedirect flow doesn't need a code from the user; the local
            // listener captures the redirect.
            Ok(String::new())
        })
    }
}

// ==================== OAuth2 Token Manager ====================

/// Manages Gmail OAuth2 tokens with auto-refresh
struct GmailTokenManager {
    client_id: String,
    client_secret: String,
    #[allow(dead_code)]
    email: String,
    token_path: String,
}

impl GmailTokenManager {
    fn new(client_id: &str, client_secret: &str, email: &str, workspace_path: &str) -> Self {
        let token_path = format!(
            "{}/{}/{}",
            workspace_path,
            crate::TEAMCLU_DIR,
            TOKEN_FILE_NAME
        );
        Self {
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            email: email.to_string(),
            token_path,
        }
    }

    fn build_secret(&self) -> yup_oauth2::ApplicationSecret {
        yup_oauth2::ApplicationSecret {
            client_id: self.client_id.clone(),
            client_secret: self.client_secret.clone(),
            auth_uri: "https://accounts.google.com/o/oauth2/auth".to_string(),
            token_uri: "https://oauth2.googleapis.com/token".to_string(),
            redirect_uris: vec!["http://localhost".to_string()],
            ..Default::default()
        }
    }

    /// Perform the OAuth2 authorization flow. The provided callback receives
    /// the auth URL when the flow is ready to present it; the default delegate
    /// will also try to open it in the system browser.
    async fn authorize(&self, on_url: AuthUrlCallback) -> Result<String, String> {
        let secret = self.build_secret();
        let auth = yup_oauth2::InstalledFlowAuthenticator::builder(
            secret,
            yup_oauth2::InstalledFlowReturnMethod::HTTPRedirect,
        )
        .persist_tokens_to_disk(&self.token_path)
        .flow_delegate(Box::new(BrowserOpenerDelegate { on_url }))
        .build()
        .await
        .map_err(|e| format!("Failed to build authenticator: {}", e))?;

        let token = auth
            .token(&[GMAIL_SCOPE])
            .await
            .map_err(|e| format!("Failed to get token: {}", e))?;

        token
            .token()
            .map(|t| t.to_string())
            .ok_or_else(|| "No access token in response".to_string())
    }

    /// Get a valid access token (auto-refreshes if expired)
    async fn get_access_token(&self) -> Result<String, String> {
        let secret = self.build_secret();
        let auth = yup_oauth2::InstalledFlowAuthenticator::builder(
            secret,
            yup_oauth2::InstalledFlowReturnMethod::HTTPRedirect,
        )
        .persist_tokens_to_disk(&self.token_path)
        .build()
        .await
        .map_err(|e| format!("Failed to build authenticator: {}", e))?;

        let token = auth
            .token(&[GMAIL_SCOPE])
            .await
            .map_err(|e| format!("Failed to refresh token: {}", e))?;

        token
            .token()
            .map(|t| t.to_string())
            .ok_or_else(|| "No access token in response".to_string())
    }
}

// ==================== XOAUTH2 for sync IMAP ====================

/// Build XOAUTH2 authentication string for IMAP
/// Format: base64("user={email}\x01auth=Bearer {token}\x01\x01")
struct XOAuth2 {
    user: String,
    access_token: String,
}

impl imap::Authenticator for XOAuth2 {
    type Response = String;
    fn process(&self, _data: &[u8]) -> Self::Response {
        format!(
            "user={}\x01auth=Bearer {}\x01\x01",
            self.user, self.access_token
        )
    }
}

// ==================== Email Gateway ====================

/// Email gateway that monitors inbox via IMAP IDLE and sends replies via SMTP
#[derive(Clone)]
pub struct EmailGateway {
    config: Arc<RwLock<EmailConfig>>,
    pub agent: Arc<dyn AgentHandle>,
    pub store: Arc<dyn ChannelStore>,
    pub team_id: String,
    pub primary_agent_actor_id: String,
    pub agent_owner_actor_ids: Vec<String>,
    shutdown_flag: Arc<AtomicBool>,
    shutdown_tx: Arc<RwLock<Option<oneshot::Sender<()>>>>,
    status: Arc<RwLock<EmailGatewayStatusResponse>>,
    is_running: Arc<RwLock<bool>>,
    workspace_path: Arc<RwLock<Option<String>>>,
    /// Generation counter: incremented on each start(). Old threads compare their
    /// generation against this and exit if they no longer match, preventing
    /// duplicate processing when IDLE blocks the old thread during restart.
    generation: Arc<AtomicU64>,
    /// Email database for persistent state (UID watermark, processed UIDs, message threads)
    email_db: Arc<RwLock<Option<EmailDb>>>,
    /// Pending questions waiting for email replies
    pub pending_questions: Arc<super::PendingQuestionStore>,
    /// Set once the daemon wires the core pipeline; the inline path is skipped.
    inbound_sink: Arc<RwLock<Option<Arc<dyn crate::driver::InboundSink>>>>,
    /// Last inbound mail per thread, so the driver can address its reply.
    reply_targets: ReplyTargets,
}

impl EmailGateway {
    pub fn new(
        agent: Arc<dyn AgentHandle>,
        store: Arc<dyn ChannelStore>,
        team_id: String,
        primary_agent_actor_id: String,
        agent_owner_actor_ids: Vec<String>,
    ) -> Self {
        Self {
            config: Arc::new(RwLock::new(EmailConfig::default())),
            agent,
            store,
            team_id,
            primary_agent_actor_id,
            agent_owner_actor_ids,
            shutdown_flag: Arc::new(AtomicBool::new(false)),
            shutdown_tx: Arc::new(RwLock::new(None)),
            status: Arc::new(RwLock::new(EmailGatewayStatusResponse::default())),
            is_running: Arc::new(RwLock::new(false)),
            workspace_path: Arc::new(RwLock::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
            email_db: Arc::new(RwLock::new(None)),
            pending_questions: Arc::new(super::PendingQuestionStore::new()),
            inbound_sink: Arc::new(RwLock::new(None)),
            reply_targets: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Hand inbound mail to the core instead of the inline handler.
    pub async fn use_core_pipeline(&self, sink: Arc<dyn crate::driver::InboundSink>) {
        *self.inbound_sink.write().await = Some(sink);
    }

    /// A driver for the core to render replies through.
    pub async fn as_driver(&self) -> EmailDriver {
        EmailDriver {
            config: self.config.read().await.clone(),
            workspace_path: self.workspace_path.read().await.clone().unwrap_or_default(),
            reply_targets: Arc::clone(&self.reply_targets),
        }
    }

    pub async fn set_config(&self, config: EmailConfig) {
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    pub async fn set_workspace_path(&self, workspace_path: &str) {
        let mut wp = self.workspace_path.write().await;
        *wp = Some(workspace_path.to_string());

        // Initialize email database
        let db_path = std::path::PathBuf::from(workspace_path)
            .join(crate::TEAMCLU_DIR)
            .join("email.db");

        match EmailDb::new(&db_path).await {
            Ok(db) => {
                let mut email_db = self.email_db.write().await;
                *email_db = Some(db);
                println!("[Email] Database initialized at: {}", db_path.display());
            }
            Err(e) => {
                eprintln!("[Email] Failed to initialize database: {}", e);
            }
        }
    }

    pub async fn get_status(&self) -> EmailGatewayStatusResponse {
        self.status.read().await.clone()
    }

    pub async fn start(&self) -> Result<(), String> {
        {
            let running = self.is_running.read().await;
            if *running {
                return Err("Email gateway is already running".to_string());
            }
        }

        let config = self.config.read().await.clone();

        // Validate configuration
        match config.provider {
            EmailProvider::Gmail => {
                if config.gmail_client_id.is_empty() || config.gmail_client_secret.is_empty() {
                    return Err("Gmail OAuth2 client ID and secret are required".to_string());
                }
                if config.gmail_email.is_empty() {
                    return Err("Gmail email address is required".to_string());
                }
            }
            EmailProvider::Custom => {
                if config.imap_server.is_empty() || config.smtp_server.is_empty() {
                    return Err("IMAP and SMTP server addresses are required".to_string());
                }
                if config.username.is_empty() || config.password.is_empty() {
                    return Err("Username and password are required".to_string());
                }
            }
        }

        // Set status to connecting
        {
            let mut status = self.status.write().await;
            status.status = EmailGatewayStatus::Connecting;
            status.error_message = None;
            status.email = Some(match config.provider {
                EmailProvider::Gmail => config.gmail_email.clone(),
                EmailProvider::Custom => config.username.clone(),
            });
        }

        // Set running flag and bump generation to invalidate any old threads
        {
            let mut running = self.is_running.write().await;
            *running = true;
        }
        self.shutdown_flag.store(false, Ordering::SeqCst);
        let my_generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;

        // Create shutdown channel
        let (shutdown_tx, _shutdown_rx) = oneshot::channel::<()>();
        {
            let mut tx = self.shutdown_tx.write().await;
            *tx = Some(shutdown_tx);
        }

        // For Gmail, get access token first (async, before spawning blocking thread)
        let access_token = if config.provider == EmailProvider::Gmail {
            let workspace_path = self.workspace_path.read().await;
            let workspace = workspace_path.as_ref().ok_or("No workspace path")?;
            let token_manager = GmailTokenManager::new(
                &config.gmail_client_id,
                &config.gmail_client_secret,
                &config.gmail_email,
                workspace,
            );
            Some(token_manager.get_access_token().await?)
        } else {
            None
        };

        // Clone for the blocking thread
        let gateway = self.clone();
        let shutdown_flag = self.shutdown_flag.clone();
        let generation = self.generation.clone();

        // Capture tokio runtime handle so the blocking thread can update
        // async state (status, session mapping).  std::thread::spawn threads
        // don't have a tokio context, so Handle::try_current() would fail.
        let rt_handle = tokio::runtime::Handle::current();

        // Get email database instance
        let email_db = {
            let db_lock = self.email_db.read().await;
            db_lock.clone()
        };

        // Spawn a dedicated blocking thread for IMAP operations
        std::thread::spawn(move || {
            run_email_gateway_blocking(
                gateway,
                config,
                access_token,
                shutdown_flag,
                generation,
                my_generation,
                rt_handle,
                email_db,
            );
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let running = {
            let r = self.is_running.read().await;
            *r
        };

        if !running {
            return Err("Email gateway is not running".to_string());
        }

        // Signal shutdown
        self.shutdown_flag.store(true, Ordering::SeqCst);

        // Send shutdown signal via oneshot
        let tx = {
            let mut shutdown = self.shutdown_tx.write().await;
            shutdown.take()
        };
        if let Some(tx) = tx {
            let _ = tx.send(());
        }

        // Wait for the IMAP thread to detect shutdown flag and exit
        // (it checks every ~1 second in poll mode, so 10s should be plenty)
        for _ in 0..100 {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            if !*self.is_running.read().await {
                break;
            }
        }

        // Force reset state in case the wait timed out
        {
            let mut running = self.is_running.write().await;
            *running = false;
        }
        {
            let mut status = self.status.write().await;
            status.status = EmailGatewayStatus::Disconnected;
            status.error_message = None;
        }

        // NOTE: Do NOT clear email session mappings on stop.
        // Unlike Discord/Feishu, email thread context is protocol-level
        // (Message-ID, In-Reply-To, References). Clearing the mapping
        // would break session continuity for ongoing email conversations
        // after a gateway restart.
        println!("[Email] Gateway fully stopped (session mappings preserved)");
        Ok(())
    }

    /// Consuming shutdown used by the amuxd channel manager.
    pub async fn shutdown(self) {
        if let Err(e) = self.stop().await {
            eprintln!("[Email] shutdown: {e}");
        }
    }

    pub async fn gmail_authorize(
        client_id: &str,
        client_secret: &str,
        email: &str,
        workspace_path: &str,
        on_url: AuthUrlCallback,
    ) -> Result<String, String> {
        let token_manager = GmailTokenManager::new(client_id, client_secret, email, workspace_path);
        token_manager.authorize(on_url).await
    }

    pub async fn check_gmail_auth(workspace_path: &str) -> bool {
        let token_path = format!(
            "{}/{}/{}",
            workspace_path,
            crate::TEAMCLU_DIR,
            TOKEN_FILE_NAME
        );
        std::path::Path::new(&token_path).exists()
    }

    pub async fn test_connection(config: &EmailConfig) -> Result<String, String> {
        match config.provider {
            EmailProvider::Custom => {
                let server = config.imap_server.clone();
                let port = config.imap_port;
                let username = config.username.clone();
                let password = config.password.clone();
                let config_clone = config.clone();

                tokio::task::spawn_blocking(move || {
                    let tls = native_tls::TlsConnector::builder()
                        .build()
                        .map_err(|e| format!("TLS error: {}", e))?;
                    // Use connect_imap_with_id so the ID command (if needed) is sent
                    // at the raw TLS level before the imap::Client is created.
                    let client = connect_imap_with_id(server.as_str(), port, &tls, &config_clone)?;
                    let mut session = client
                        .login(&username, &password)
                        .map_err(|e| format!("IMAP login failed: {}", e.0))?;
                    session
                        .select("INBOX")
                        .map_err(|e| format!("IMAP select INBOX failed: {}", e))?;
                    let _ = session.logout();
                    Ok(format!(
                        "Connected and selected INBOX on {}:{} successfully",
                        server, port
                    ))
                })
                .await
                .map_err(|e| format!("Task error: {}", e))?
            }
            EmailProvider::Gmail => {
                Ok("Use 'Authorize with Google' to test Gmail connection".to_string())
            }
        }
    }
}

// ==================== Blocking IMAP Gateway Loop ====================

fn run_email_gateway_blocking(
    gateway: EmailGateway,
    config: EmailConfig,
    access_token: Option<String>,
    shutdown_flag: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    my_generation: u64,
    rt_handle: tokio::runtime::Handle,
    email_db: Option<EmailDb>,
) {
    let mut backoff_secs: u64 = 2;
    let max_backoff: u64 = 60;

    println!(
        "[Email] Starting email gateway gen={} for provider: {:?}",
        my_generation, config.provider
    );

    // Generate account key for database operations
    let account_key = match config.provider {
        EmailProvider::Gmail => config.gmail_email.clone(),
        EmailProvider::Custom => config.username.clone(),
    };
    println!("[Email] Account key: {}", account_key);

    loop {
        if shutdown_flag.load(Ordering::SeqCst) {
            println!("[Email] Shutdown flag detected (gen={})", my_generation);
            break;
        }
        // Check if a newer generation has started (restart happened while we were in IDLE)
        if generation.load(Ordering::SeqCst) != my_generation {
            println!(
                "[Email] Generation mismatch (mine={}, current={}), exiting stale thread",
                my_generation,
                generation.load(Ordering::SeqCst)
            );
            break;
        }

        match handle_imap_connection(
            &gateway,
            &config,
            access_token.as_deref(),
            &shutdown_flag,
            &generation,
            my_generation,
            &rt_handle,
            email_db.as_ref(),
            &account_key,
        ) {
            Ok(()) => {
                println!("[Email] Connection ended normally");
                backoff_secs = 2;
            }
            Err(e) => {
                println!("[Email] Connection error: {}", e);
                let error_message = e.clone();
                let status = gateway.status.clone();
                rt_handle.block_on(async {
                    let mut s = status.write().await;
                    s.status = EmailGatewayStatus::Error;
                    s.error_message = Some(error_message);
                });

                // Some IMAP errors are account-policy related and will not recover by retrying.
                // Stop the loop to avoid noisy infinite reconnect attempts.
                if is_non_retriable_email_error(&e) {
                    println!("[Email] Non-retriable IMAP error detected, stopping reconnect loop");
                    break;
                }
            }
        }

        if shutdown_flag.load(Ordering::SeqCst) {
            break;
        }

        println!("[Email] Reconnecting in {} seconds...", backoff_secs);
        std::thread::sleep(std::time::Duration::from_secs(backoff_secs));
        backoff_secs = (backoff_secs * 2).min(max_backoff);

        // Update status to connecting
        let status = gateway.status.clone();
        rt_handle.block_on(async {
            let mut s = status.write().await;
            s.status = EmailGatewayStatus::Connecting;
            s.error_message = None;
        });
    }

    // Final cleanup
    {
        let status = gateway.status.clone();
        let is_running = gateway.is_running.clone();
        let stopped_by_shutdown = shutdown_flag.load(Ordering::SeqCst);
        rt_handle.block_on(async {
            let mut r = is_running.write().await;
            *r = false;
            if stopped_by_shutdown {
                let mut s = status.write().await;
                s.status = EmailGatewayStatus::Disconnected;
                s.error_message = None;
            }
        });
    }

    println!("[Email] Gateway loop exited");
}

fn is_non_retriable_email_error(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    lower.contains("unsafe login")
        || lower.contains("authenticationfailed")
        || lower.contains("invalid credentials")
        || lower.contains("invalid login")
        || lower.contains("account disabled")
}

fn quote_imap_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn build_support_email(config: &EmailConfig) -> String {
    let email = match config.provider {
        EmailProvider::Gmail => config.gmail_email.trim(),
        EmailProvider::Custom => config.username.trim(),
    };
    if email.contains('@') {
        email.to_string()
    } else {
        "support@teamclu.local".to_string()
    }
}

fn is_netease_imap_server(server: &str) -> bool {
    let s = server.to_lowercase();
    s.contains("imap.163.com") || s.contains("imap.126.com") || s.contains("imap.yeah.net")
}

/// Read a single line (terminated by `\n`) from a stream one byte at a time.
///
/// This is intentionally unbuffered to guarantee that we never read past the
/// end of the line.  When handing the stream off to `imap::Client::new` later,
/// its internal `BufStream` will start reading from the exact byte after the
/// last `\n` we consumed here – no data is lost or duplicated.
fn read_line_unbuffered<T: std::io::Read>(stream: &mut T) -> Result<String, String> {
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        stream
            .read_exact(&mut byte)
            .map_err(|e| format!("Read error: {}", e))?;
        buf.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    String::from_utf8(buf).map_err(|e| format!("UTF-8 error: {}", e))
}

/// Connect to an IMAP server over TLS, optionally sending RFC2971 ID command
/// at the raw TLS level BEFORE creating the `imap::Client`.
///
/// The `imap` crate's `imap-proto` parser cannot handle `* ID (...)` untagged
/// responses (RFC2971 is not implemented), so we must send the ID command at the
/// raw TLS stream layer and consume its response ourselves.  This avoids:
///  - `ParseError::Invalid` ("Unable to parse status response")
///  - Tag mismatch panics when a stale tagged OK line is read by subsequent cmds
///
/// **Critical**: we use `read_line_unbuffered` (1-byte reads) so that absolutely
/// no extra bytes are consumed from the TLS stream.  When `imap::Client::new`
/// wraps the stream, its `BufStream` picks up exactly where we left off.
///
/// For non-NetEase servers the standard `imap::connect` path is used unchanged.
fn connect_imap_with_id(
    imap_server: &str,
    imap_port: u16,
    tls_connector: &native_tls::TlsConnector,
    config: &EmailConfig,
) -> Result<imap::Client<native_tls::TlsStream<std::net::TcpStream>>, String> {
    if !is_netease_imap_server(imap_server) {
        // Standard path – no ID needed
        return imap::connect((imap_server, imap_port), imap_server, tls_connector)
            .map_err(|e| format!("IMAP connect failed: {}", e));
    }

    // ---- NetEase path: manual TLS + raw ID command ----

    let tcp = std::net::TcpStream::connect((imap_server, imap_port))
        .map_err(|e| format!("TCP connect failed: {}", e))?;

    let mut tls_stream = native_tls::TlsConnector::connect(tls_connector, imap_server, tcp)
        .map_err(|e| format!("TLS handshake failed: {}", e))?;

    // 1. Read server greeting (e.g. "* OK ...") – one byte at a time, no buffering
    let greeting = read_line_unbuffered(&mut tls_stream)?;
    println!("[Email] IMAP Greeting: {}", greeting.trim());

    // 2. Build and send ID command.
    //    Tag prefix "x0" will NOT collide with the imap crate's internal "a" prefix.
    let support_email = build_support_email(config);
    let id_cmd = format!(
        "x0 ID (\"name\" \"teamclu\" \"version\" \"0.1.0\" \"vendor\" \"teamclu\" \"support-email\" {})\r\n",
        quote_imap_string(&support_email)
    );
    tls_stream
        .write_all(id_cmd.as_bytes())
        .map_err(|e| format!("Failed to send IMAP ID: {}", e))?;
    tls_stream
        .flush()
        .map_err(|e| format!("Failed to flush IMAP ID: {}", e))?;

    println!("[Email] Sent raw IMAP ID command");

    // 3. Read response lines until we see our tagged response "x0 ..."
    let mut id_ok = false;
    loop {
        let line = read_line_unbuffered(&mut tls_stream)?;
        let trimmed = line.trim();
        println!("[Email] ID response line: {}", trimmed);
        if trimmed.starts_with("x0 ") {
            // e.g. "x0 OK ID completed" or "x0 NO ..." or "x0 BAD ..."
            if trimmed.contains(" OK ") || trimmed.ends_with(" OK") {
                id_ok = true;
            }
            break;
        }
    }
    if id_ok {
        println!("[Email] IMAP ID handshake completed successfully");
    } else {
        println!("[Email] IMAP ID handshake returned non-OK (continuing anyway)");
    }

    // 4. Create imap::Client from the TLS stream.
    //    `Client::new` wraps it in a fresh BufStream with tag counter starting at 0.
    //    We do NOT call `client.read_greeting()` because we already consumed the greeting.
    //    This is safe: `login()` and `authenticate()` never check `greeting_read`.
    let client = imap::Client::new(tls_stream);

    Ok(client)
}

/// Handle a single IMAP connection cycle (sync/blocking)
fn handle_imap_connection(
    gateway: &EmailGateway,
    config: &EmailConfig,
    access_token: Option<&str>,
    shutdown_flag: &Arc<AtomicBool>,
    generation: &Arc<AtomicU64>,
    my_generation: u64,
    rt_handle: &tokio::runtime::Handle,
    email_db: Option<&EmailDb>,
    account_key: &str,
) -> Result<(), String> {
    let (imap_server, imap_port) = match config.provider {
        EmailProvider::Gmail => (GMAIL_IMAP_SERVER.to_string(), GMAIL_IMAP_PORT),
        EmailProvider::Custom => (config.imap_server.clone(), config.imap_port),
    };

    println!("[Email] Connecting to IMAP {}:{}", imap_server, imap_port);

    let tls = native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| format!("TLS error: {}", e))?;

    // Connect with optional RFC2971 ID command (handled at raw TLS level
    // before the imap::Client is created, bypassing imap-proto parser).
    let client = connect_imap_with_id(imap_server.as_str(), imap_port, &tls, config)?;

    // Authenticate
    let mut session = match config.provider {
        EmailProvider::Gmail => {
            let token = access_token.ok_or("No access token for Gmail")?;
            let auth = XOAuth2 {
                user: config.gmail_email.clone(),
                access_token: token.to_string(),
            };
            client
                .authenticate("XOAUTH2", &auth)
                .map_err(|e| format!("Gmail XOAUTH2 auth failed: {}", e.0))?
        }
        EmailProvider::Custom => client
            .login(&config.username, &config.password)
            .map_err(|e| format!("IMAP login failed: {}", e.0))?,
    };

    println!("[Email] IMAP authenticated successfully");

    // Select INBOX
    session
        .select("INBOX")
        .map_err(|e| format!("Failed to select INBOX: {}", e))?;

    println!("[Email] INBOX selected");

    // Check if server supports IDLE (RFC 2177).
    // Some servers (e.g. 163.com Coremail) do NOT support IDLE, and the imap
    // crate panics when it tries to send DONE to a non-IDLE server.
    let supports_idle = session
        .capabilities()
        .map(|caps| caps.has_str("IDLE"))
        .unwrap_or(false);

    if supports_idle {
        println!("[Email] Server supports IDLE – using push notifications");
    } else {
        println!(
            "[Email] Server does NOT support IDLE – falling back to polling every {}s",
            POLL_INTERVAL_SECS
        );
    }

    // Update status to connected
    {
        let status = gateway.status.clone();
        rt_handle.block_on(async {
            let mut s = status.write().await;
            s.status = EmailGatewayStatus::Connected;
            s.error_message = None;
        });
    }

    // UID water mark: only process messages with UID > this value.
    // This is much more efficient than scanning all UNSEEN/SINCE messages,
    // especially for mailboxes with thousands of unread emails.
    let mut uid_watermark: u32 = if let Some(db) = email_db {
        // Try to load from database first
        match rt_handle.block_on(db.get_uid_watermark(account_key)) {
            Ok(watermark) if watermark > 0 => {
                println!("[Email] Loaded UID watermark from database: {}", watermark);
                watermark
            }
            _ => {
                // Database doesn't have a watermark yet, fetch current max UID from server
                match get_max_uid(&mut session) {
                    Ok(max_uid) => {
                        println!("[Email] Initial UID watermark from server: {} (all existing messages will be skipped)", max_uid);
                        // Store in database for next time
                        if let Err(e) =
                            rt_handle.block_on(db.update_uid_watermark(account_key, max_uid))
                        {
                            println!(
                                "[Email] Warning: failed to store uid_watermark in db: {}",
                                e
                            );
                        }
                        max_uid
                    }
                    Err(e) => {
                        println!("[Email] Warning: failed to get max UID: {}, using 0", e);
                        0
                    }
                }
            }
        }
    } else {
        // No database available, fallback to old behavior
        match get_max_uid(&mut session) {
            Ok(max_uid) => {
                println!(
                    "[Email] Initial UID watermark: {} (all existing messages will be skipped)",
                    max_uid
                );
                max_uid
            }
            Err(e) => {
                println!("[Email] Warning: failed to get max UID: {}, using 0", e);
                0
            }
        }
    };

    // Also track processed UIDs within the current session to avoid duplicates
    // (database is used for long-term persistence, HashSet for in-memory dedup)
    let mut processed_uids: HashSet<u32> = HashSet::new();

    // Main monitoring loop (IDLE or polling)
    loop {
        if shutdown_flag.load(Ordering::SeqCst) {
            break;
        }
        // Stale generation check: if a newer start() was called, exit this thread
        if generation.load(Ordering::SeqCst) != my_generation {
            println!(
                "[Email] Stale generation detected in IMAP loop (mine={}, current={}), exiting",
                my_generation,
                generation.load(Ordering::SeqCst)
            );
            break;
        }

        if supports_idle {
            // ---- IDLE path (push) ----
            println!("[Email] Entering IDLE...");

            let idle_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut idle_handle = session
                    .idle()
                    .map_err(|e| format!("IDLE init failed: {}", e))?;
                idle_handle.set_keepalive(std::time::Duration::from_secs(IDLE_TIMEOUT_SECS));
                idle_handle
                    .wait_keepalive()
                    .map_err(|e| format!("IDLE wait failed: {}", e))?;
                Ok::<(), String>(())
            }));

            // After IDLE returns, immediately check if we're still the active generation
            if generation.load(Ordering::SeqCst) != my_generation {
                println!(
                    "[Email] Stale generation after IDLE (mine={}, current={}), exiting",
                    my_generation,
                    generation.load(Ordering::SeqCst)
                );
                break;
            }

            match idle_result {
                Ok(Ok(())) => {
                    println!("[Email] IDLE returned with activity");
                }
                Ok(Err(e)) => {
                    println!("[Email] IDLE error: {}", e);
                    return Err(e);
                }
                Err(panic_payload) => {
                    let msg = if let Some(s) = panic_payload.downcast_ref::<String>() {
                        s.clone()
                    } else if let Some(s) = panic_payload.downcast_ref::<&str>() {
                        s.to_string()
                    } else {
                        "unknown panic".to_string()
                    };
                    println!("[Email] IDLE panicked: {}", msg);
                    return Err(format!("IDLE panic: {}", msg));
                }
            }
        } else {
            // ---- Polling path ----
            // Sleep in small increments so we can detect shutdown quickly.
            let poll_end =
                std::time::Instant::now() + std::time::Duration::from_secs(POLL_INTERVAL_SECS);
            while std::time::Instant::now() < poll_end {
                if shutdown_flag.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_secs(1));
            }

            if shutdown_flag.load(Ordering::SeqCst) {
                break;
            }

            // After sleep, re-select INBOX to refresh server-side state
            // (NOOP could also work but SELECT is more reliable).
            session.noop().map_err(|e| format!("NOOP failed: {}", e))?;
        }

        if shutdown_flag.load(Ordering::SeqCst) {
            break;
        }

        // Search for new messages using UID watermark (very efficient).
        // Only returns UIDs > uid_watermark, so no scanning of historical mail.
        let new_uids = match search_new_messages_since_uid(&mut session, uid_watermark) {
            Ok(uids) => {
                // Further filter by processed_uids (memory + database check)
                let mut filtered = Vec::new();
                for uid in uids {
                    // First check in-memory HashSet (fast)
                    if processed_uids.contains(&uid) {
                        continue;
                    }
                    // Then check database (slower but persistent)
                    if let Some(db) = email_db {
                        match rt_handle.block_on(db.is_uid_processed(account_key, uid)) {
                            Ok(true) => {
                                // Already processed, add to in-memory set for faster future checks
                                processed_uids.insert(uid);
                                continue;
                            }
                            Ok(false) => {
                                // Not processed, include it
                            }
                            Err(e) => {
                                println!("[Email] Warning: failed to check uid in db: {}", e);
                                // On error, assume not processed
                            }
                        }
                    }
                    filtered.push(uid);
                }
                filtered
            }
            Err(e) => {
                println!("[Email] Search failed: {}", e);
                Vec::new()
            }
        };

        if !new_uids.is_empty() {
            println!(
                "[Email] Found {} new messages (watermark={})",
                new_uids.len(),
                uid_watermark
            );
        }

        for uid in new_uids {
            // Update watermark so subsequent searches skip this UID
            if uid > uid_watermark {
                uid_watermark = uid;
                // Persist watermark to database
                if let Some(db) = email_db {
                    if let Err(e) =
                        rt_handle.block_on(db.update_uid_watermark(account_key, uid_watermark))
                    {
                        println!(
                            "[Email] Warning: failed to update uid_watermark in db: {}",
                            e
                        );
                    }
                }
            }

            // Mark as seen and track as processed BEFORE processing,
            // so a gateway restart won't pick up the same message again.
            let _ = session.uid_store(uid.to_string(), "+FLAGS (\\Seen)");
            processed_uids.insert(uid);

            // Also persist to database for cross-session deduplication
            if let Some(db) = email_db {
                if let Err(e) = rt_handle.block_on(db.mark_uid_processed(account_key, uid)) {
                    println!(
                        "[Email] Warning: failed to mark uid as processed in db: {}",
                        e
                    );
                }
            }

            // Fetch the message
            let messages = session
                .uid_fetch(uid.to_string(), "RFC822")
                .map_err(|e| format!("IMAP fetch failed: {}", e))?;

            if let Some(message) = messages.iter().next() {
                if let Some(body) = message.body() {
                    // Wrap parse_email in catch_unwind to guard against panics
                    // in the mail-parser crate (e.g., "String full while decoding"
                    // when processing certain multi-byte encoded emails).
                    let parse_result =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            parse_email(uid, body)
                        }));

                    let email_result = match parse_result {
                        Ok(result) => result,
                        Err(panic_payload) => {
                            let msg = if let Some(s) = panic_payload.downcast_ref::<String>() {
                                s.clone()
                            } else if let Some(s) = panic_payload.downcast_ref::<&str>() {
                                s.to_string()
                            } else {
                                "unknown panic".to_string()
                            };
                            println!("[Email] mail-parser panicked on UID {}: {}", uid, msg);
                            continue;
                        }
                    };

                    match email_result {
                        Ok(email_msg) => {
                            // Skip emails sent by the system itself (prevent reply loops).
                            // Our outgoing emails have Message-ID containing "teamclu-".
                            if email_msg.message_id.contains("teamclu-") {
                                println!(
                                    "[Email] Skipping self-sent message (Message-ID: {})",
                                    email_msg.message_id
                                );
                                continue;
                            }

                            println!(
                                "[Email] Processing message from: {} subject: {}",
                                email_msg.from, email_msg.subject
                            );

                            let filter_result = check_email_filter(config, &email_msg);
                            match filter_result {
                                FilterResult::Allow => {
                                    // The core pipeline, when the daemon has
                                    // wired it. The thread key is resolved here
                                    // because it needs an EmailDb lookup, which
                                    // `ChannelDriver::binding` cannot do.
                                    if let Some(sink) =
                                        rt_handle.block_on(gateway.inbound_sink.read()).clone()
                                    {
                                        let thread_key = resolve_thread_key_sync(
                                            gateway,
                                            &email_msg,
                                            rt_handle,
                                            email_db,
                                            account_key,
                                        );
                                        rt_handle.block_on(async {
                                            gateway
                                                .reply_targets
                                                .write()
                                                .await
                                                .insert(thread_key.clone(), email_msg.clone());
                                            sink.accept(normalize_email(
                                                account_key,
                                                &email_msg,
                                                &thread_key,
                                            ))
                                            .await;
                                        });
                                    }
                                }
                                FilterResult::RecipientAliasNotMatched => {
                                    println!(
                                        "[Email] Ignored message: recipient alias not matched. recipients={:?}",
                                        email_msg.recipients
                                    );
                                }
                                FilterResult::SenderNotAllowed => {
                                    println!("[Email] Sender not in allowlist: {}", email_msg.from);
                                    if let Err(e) =
                                        send_rejection_reply_sync(config, &email_msg, access_token)
                                    {
                                        println!("[Email] Failed to send rejection: {}", e);
                                    }
                                }
                                FilterResult::Ignore => {
                                    println!("[Email] Message filtered out");
                                }
                            }
                        }
                        Err(e) => {
                            println!("[Email] Failed to parse message UID {}: {}", uid, e);
                        }
                    }
                }
            }

            // Cleanup in-memory HashSet
            if processed_uids.len() > MAX_PROCESSED_UIDS {
                let drain_count = processed_uids.len() - MAX_PROCESSED_UIDS / 2;
                let to_remove: Vec<u32> =
                    processed_uids.iter().take(drain_count).copied().collect();
                for u in to_remove {
                    processed_uids.remove(&u);
                }
            }

            // Periodic database cleanup to prevent unbounded growth
            if let Some(db) = email_db {
                match rt_handle.block_on(db.count_processed_uids(account_key)) {
                    Ok(count) if count > MAX_PROCESSED_UIDS => {
                        println!(
                            "[Email] Database has {} processed UIDs, cleaning up old entries",
                            count
                        );
                        if let Err(e) = rt_handle
                            .block_on(db.cleanup_processed_uids(account_key, MAX_PROCESSED_UIDS))
                        {
                            println!(
                                "[Email] Warning: failed to cleanup processed_uids in db: {}",
                                e
                            );
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        println!(
                            "[Email] Warning: failed to count processed_uids in db: {}",
                            e
                        );
                    }
                }
            }
        }
    }

    let _ = session.logout();
    println!("[Email] IMAP session closed");
    Ok(())
}

// ==================== Email Parsing ====================

#[derive(Clone)]
pub(crate) struct EmailMessage {
    uid: u32,
    from: String,
    recipients: Vec<String>,
    subject: String,
    message_id: String,
    in_reply_to: String,
    references: String,
    body_text: String,
}

fn parse_email(uid: u32, raw: &[u8]) -> Result<EmailMessage, String> {
    let parsed = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or("Failed to parse email")?;

    let from: String = parsed
        .from()
        .and_then(|addrs| addrs.first())
        .and_then(|a| a.address())
        .map(|s: &str| s.to_string())
        .unwrap_or_default();

    // Extract recipients from structured address headers.
    // mail-parser returns To/Cc/Bcc as typed Address lists, NOT raw text,
    // so header("To").as_text() returns None. Use the typed accessors instead.
    let mut recipients: Vec<String> = Vec::new();

    // To
    if let Some(to_addrs) = parsed.to() {
        for addr in to_addrs.iter() {
            if let Some(email) = addr.address() {
                recipients.push(email.to_lowercase());
            }
        }
    }
    // Cc
    if let Some(cc_addrs) = parsed.cc() {
        for addr in cc_addrs.iter() {
            if let Some(email) = addr.address() {
                recipients.push(email.to_lowercase());
            }
        }
    }
    // Bcc
    if let Some(bcc_addrs) = parsed.bcc() {
        for addr in bcc_addrs.iter() {
            if let Some(email) = addr.address() {
                recipients.push(email.to_lowercase());
            }
        }
    }

    recipients.sort();
    recipients.dedup();

    println!(
        "[Email] Parsed recipients for uid={}: {:?}",
        uid, recipients
    );

    let subject = parsed.subject().unwrap_or("").to_string();
    let message_id = parsed.message_id().unwrap_or("").to_string();
    let in_reply_to = parsed
        .header("In-Reply-To")
        .and_then(|h| h.as_text())
        .map(|s: &str| s.to_string())
        .unwrap_or_default();

    // Extract References header - try to get raw value
    let references: String = parsed
        .header("References")
        .and_then(|h| h.as_text())
        .map(|s: &str| s.to_string())
        .unwrap_or_default();

    let body_text = parsed
        .body_text(0)
        .map(|t| t.to_string())
        .unwrap_or_default();

    Ok(EmailMessage {
        uid,
        from,
        recipients,
        subject,
        message_id,
        in_reply_to,
        references,
        body_text,
    })
}

#[allow(dead_code)]
fn extract_emails_from_header(raw: &str) -> Vec<String> {
    if raw.trim().is_empty() {
        return Vec::new();
    }

    let mut emails: Vec<String> = Vec::new();
    for part in raw.split(',') {
        let item = part.trim();
        if item.is_empty() {
            continue;
        }

        let candidate = if let (Some(start), Some(end)) = (item.find('<'), item.rfind('>')) {
            if end > start + 1 {
                item[start + 1..end].trim()
            } else {
                item
            }
        } else {
            item
        };

        let cleaned = candidate.trim().trim_matches('"').to_lowercase();
        if cleaned.contains('@') {
            emails.push(cleaned);
        }
    }
    emails
}

fn build_expected_alias_recipient(config: &EmailConfig) -> Option<String> {
    let alias = config.recipient_alias.trim();
    if alias.is_empty() {
        return None;
    }

    let base_email = match config.provider {
        EmailProvider::Gmail => config.gmail_email.trim(),
        EmailProvider::Custom => config.username.trim(),
    };
    let (local, domain) = base_email.split_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }

    let local_base = local.split('+').next().unwrap_or(local).trim();
    if local_base.is_empty() {
        return None;
    }

    Some(format!(
        "{}+{}@{}",
        local_base.to_lowercase(),
        alias.to_lowercase(),
        domain.to_lowercase()
    ))
}

// ==================== Email Filtering ====================

enum FilterResult {
    Allow,
    RecipientAliasNotMatched,
    SenderNotAllowed,
    Ignore,
}

fn check_email_filter(config: &EmailConfig, email: &EmailMessage) -> FilterResult {
    // Step 1: If a recipient alias is configured, check it first.
    // The alias acts as an optional address-level gate.
    let alias = config.recipient_alias.trim();
    if !alias.is_empty() {
        let expected_alias_recipient = build_expected_alias_recipient(config);
        if let Some(ref expected) = expected_alias_recipient {
            let matched = email
                .recipients
                .iter()
                .any(|recipient| recipient.eq_ignore_ascii_case(expected));
            println!(
                "[Email] Filter: alias={}, expected={}, matched={}",
                alias, expected, matched
            );
            if !matched {
                return FilterResult::RecipientAliasNotMatched;
            }
        }
    }

    // Step 2: Check Allowed Senders list (if configured).
    // When the list is non-empty, only emails from listed senders are allowed.
    if !config.allowed_senders.is_empty() {
        let sender = email.from.to_lowercase();
        let is_allowed = config.allowed_senders.iter().any(|pattern| {
            let p = pattern.to_lowercase();
            if let Some(suffix) = p.strip_prefix('*') {
                sender.ends_with(suffix)
            } else {
                sender == p
            }
        });

        if !is_allowed {
            println!("[Email] Filter: sender {} not in allowlist", email.from);
            return FilterResult::SenderNotAllowed;
        }
        return FilterResult::Allow;
    }

    // Step 3: No alias configured and no allowed senders configured.
    // Use the reply_all_new flag to decide.
    if alias.is_empty() && config.allowed_senders.is_empty() {
        if config.reply_all_new {
            println!("[Email] Filter: no alias, no allowed senders, reply_all_new=true => allow");
            return FilterResult::Allow;
        } else {
            println!("[Email] Filter: no alias, no allowed senders, reply_all_new=false => ignore");
            return FilterResult::Ignore;
        }
    }

    FilterResult::Allow
}

// ==================== OpenCode Integration (sync via tokio handle) ====================

/// Strip reply/forward prefixes (Re:, Fwd:, Fw:) from an email subject.
/// Used by both the gateway and cron scheduler for subject-based session matching.
pub fn normalize_subject(subject: &str) -> String {
    let mut s = subject.trim().to_string();
    loop {
        let lower = s.to_lowercase();
        if lower.starts_with("re:") {
            s = s[3..].trim().to_string();
        } else if lower.starts_with("fwd:") {
            s = s[4..].trim().to_string();
        } else if lower.starts_with("fw:") {
            s = s[3..].trim().to_string();
        } else {
            break;
        }
    }
    s
}

fn has_reply_prefix(subject: &str) -> bool {
    let s = subject.trim().to_lowercase();
    s.starts_with("re:") || s.starts_with("fwd:") || s.starts_with("fw:")
}

/// Normalize a Message-ID by trimming whitespace and angle brackets, lowercasing.
/// Used by both the gateway and cron scheduler for message-id indexing.
pub fn normalize_message_id(message_id: &str) -> String {
    message_id
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>')
        .to_lowercase()
}

fn extract_message_ids(raw: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor = raw;
    while let Some(start) = cursor.find('<') {
        let rest = &cursor[start + 1..];
        if let Some(end) = rest.find('>') {
            let id = normalize_message_id(&rest[..end]);
            if !id.is_empty() {
                ids.push(id);
            }
            cursor = &rest[end + 1..];
        } else {
            break;
        }
    }
    if ids.is_empty() {
        for token in raw.split_whitespace() {
            let id = normalize_message_id(token);
            if id.contains('@') {
                ids.push(id);
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

fn build_thread_session_key(email: &EmailMessage) -> String {
    let msg_id = normalize_message_id(&email.message_id);
    if !msg_id.is_empty() {
        return format!("email:thread:{}", msg_id);
    }
    format!("email:thread:uid:{}", email.uid)
}

/// Resolve a prior thread → session binding for an inbound email so the
/// follow-up reply lands in the *same* backend session instead of a new
/// one per message. Returns `Some(binding)` if any previously persisted
/// Message-ID in this email's `In-Reply-To` / `References` chain (or a
/// subject-based fallback) was tagged with a binding; falls back to
/// `None` so the caller derives a fresh binding from the current message.
fn resolve_email_session_binding_sync(
    _gateway: &EmailGateway,
    email: &EmailMessage,
    rt_handle: &tokio::runtime::Handle,
    email_db: Option<&EmailDb>,
    account_key: &str,
) -> Result<Option<String>, String> {
    let rt = rt_handle;
    let normalized_subject = normalize_subject(&email.subject).to_lowercase();
    let reply_like_subject = has_reply_prefix(&email.subject);
    let mut lookup_ids: Vec<String> = Vec::new();
    lookup_ids.extend(extract_message_ids(&email.in_reply_to));
    lookup_ids.extend(extract_message_ids(&email.references));
    lookup_ids.sort();
    lookup_ids.dedup();

    let resolved = rt.block_on(async move {
        if let Some(db) = email_db {
            // Try to find a stored binding via In-Reply-To / References chain.
            for message_id in &lookup_ids {
                if let Ok(Some((session_id, binding))) =
                    db.get_session_by_message_id(account_key, message_id).await
                {
                    println!(
                        "[Email] Session resolved by message-id index: {} -> session {} (binding={:?})",
                        message_id, session_id, binding
                    );
                    if binding.is_some() {
                        return binding;
                    }
                }
            }

            // Subject-based fallback for clients that strip threading headers.
            if reply_like_subject && !normalized_subject.is_empty() {
                if let Ok(Some((session_id, binding))) = db
                    .find_session_by_subject(account_key, &normalized_subject)
                    .await
                {
                    println!(
                        "[Email] Session resolved by subject index: {} -> session {} (binding={:?})",
                        normalized_subject, session_id, binding
                    );
                    if binding.is_some() {
                        return binding;
                    }
                }
            }
        }
        None
    });
    Ok(resolved)
}

// ==================== Transport driver (core pipeline) ====================

/// What a reply needs that the conversation id cannot carry.
///
/// Mail replies must reproduce `In-Reply-To` / `References` and the original
/// subject or the thread splits, and the recipient is the original sender —
/// none of which survive a round trip through a single id string. So the
/// inbound side stashes the message here, keyed by conversation id, and the
/// driver picks it up. Same shape as WeCom's reply context and WeChat's
/// context-token cache: transport state, held by the transport.
pub(crate) type ReplyTargets = Arc<RwLock<HashMap<String, EmailMessage>>>;

fn email_caps() -> crate::driver::ChannelCaps {
    crate::driver::ChannelCaps {
        // There is no "edit the mail I already sent". The core buffers the
        // whole answer and sends once — which is why declaring this honestly
        // matters: a channel that claimed streaming would send one mail per
        // frame, five mails to a question.
        streaming_edit: false,
        media_upload: false,
        interactive: false,
        threading: crate::driver::Threading::MailHeaders,
        // Mail has no practical body limit; splitting would be worse.
        max_chars: 100_000,
        // A mail round trip is minutes, not the IM-shaped 180s. The inline path
        // only got away with the short timeout because it blocked on the reply
        // rather than queueing the turn.
        turn_timeout_secs: 900,
    }
}

/// Conversation id for a mail thread. Only the thread key needs to survive —
/// everything else a reply needs is in [`ReplyTargets`].
fn mail_conv_id(thread_key: &str) -> String {
    thread_key.to_string()
}

/// Normalize a parsed email into the shape the core consumes.
///
/// `thread_key` is resolved by the caller because it needs an `EmailDb` lookup
/// over the `In-Reply-To` / `References` chain, and [`ChannelDriver::binding`]
/// is sync and pure by contract.
fn normalize_email(
    account_key: &str,
    email: &EmailMessage,
    thread_key: &str,
) -> crate::driver::InboundMessage {
    let body = if email.body_text.is_empty() {
        "(empty body)".to_string()
    } else {
        clean_email_body(&email.body_text)
    };
    let display = if email.from.is_empty() {
        "Email user".to_string()
    } else {
        email.from.clone()
    };
    crate::driver::InboundMessage {
        conversation: crate::driver::Conversation {
            channel: "email",
            bot_id: Some(account_key.to_string()),
            kind: crate::driver::ConversationKind::MailThread,
            id: mail_conv_id(thread_key),
        },
        sender: crate::driver::ExternalSender {
            external_id: email.from.clone(),
            display_name: display,
            email: Some(email.from.clone()),
        },
        external_message_id: if email.message_id.is_empty() {
            format!("uid:{}", email.uid)
        } else {
            normalize_message_id(&email.message_id)
        },
        text: body,
        attachments: Vec::new(),
        // Every mail to the address is addressed to us; there is no mention
        // concept to invent one from.
        addressed_to_bot: true,
        quoted_text: None,
        reply_context: Some(normalize_message_id(&email.message_id)),
    }
}

/// Email as a transport driver.
pub struct EmailDriver {
    config: EmailConfig,
    workspace_path: String,
    reply_targets: ReplyTargets,
}

#[async_trait::async_trait]
impl crate::driver::ChannelDriver for EmailDriver {
    fn id(&self) -> crate::driver::ChannelId {
        "email"
    }

    fn caps(&self) -> crate::driver::ChannelCaps {
        email_caps()
    }

    fn binding(&self, conversation: &crate::driver::Conversation) -> String {
        crate::binding::email_thread(
            conversation.bot_id.as_deref().unwrap_or_default(),
            &conversation.id,
        )
    }

    fn sender_urn(
        &self,
        _conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        crate::binding::urn_email_user(&sender.external_id)
    }

    fn session_title(
        &self,
        _conversation: &crate::driver::Conversation,
        sender: &crate::driver::ExternalSender,
    ) -> String {
        format!("Email: {}", sender.display_name)
    }

    async fn deliver(
        &self,
        to: &crate::driver::Conversation,
        _reply_context: Option<&str>,
        msg: &crate::driver::OutboundMessage,
    ) -> Result<crate::driver::DeliveryId, crate::driver::DriverError> {
        if msg.text.trim().is_empty() {
            return Ok(crate::driver::DeliveryId(to.id.clone()));
        }
        let original = self
            .reply_targets
            .read()
            .await
            .get(&to.id)
            .cloned()
            .ok_or_else(|| {
                crate::driver::DriverError::Transport(format!(
                    "no inbound mail recorded for thread {} — cannot address a reply",
                    to.id
                ))
            })?;

        let config = self.config.clone();
        let workspace = self.workspace_path.clone();
        let body = msg.text.clone();

        // Gmail needs an OAuth token, and fetching it is async; SMTP itself is
        // blocking, so the token comes first and the send goes to a blocking
        // task.
        let access_token = if config.provider == EmailProvider::Gmail {
            let mgr = GmailTokenManager::new(
                &config.gmail_client_id,
                &config.gmail_client_secret,
                &config.gmail_email,
                &workspace,
            );
            Some(
                mgr.get_access_token()
                    .await
                    .map_err(crate::driver::DriverError::Transport)?,
            )
        } else {
            None
        };

        tokio::task::spawn_blocking(move || {
            send_reply_sync(&config, &original, &body, access_token.as_deref())
        })
        .await
        .map_err(|e| crate::driver::DriverError::Transport(format!("smtp task panicked: {e}")))?
        .map_err(crate::driver::DriverError::Transport)?;

        Ok(crate::driver::DeliveryId(to.id.clone()))
    }
}

/// The thread key a mail belongs to, as the core's conversation id.
///
/// Reuses the inline path's resolution exactly — an existing thread found via
/// `In-Reply-To` / `References` (or the subject fallback) keeps its key, so a
/// reply lands in the session the thread already has; a first-time mail derives
/// one from its own Message-ID.
fn resolve_thread_key_sync(
    gateway: &EmailGateway,
    email: &EmailMessage,
    rt_handle: &tokio::runtime::Handle,
    email_db: Option<&EmailDb>,
    account_key: &str,
) -> String {
    let resolved =
        resolve_email_session_binding_sync(gateway, email, rt_handle, email_db, account_key)
            .ok()
            .flatten();
    if let Some(binding) = resolved {
        // `email://{account}/thread/{key}` — take the key back out so the core
        // can rebuild the same binding through the driver.
        if let Some(key) = binding.rsplit("/thread/").next() {
            if !key.is_empty() && key != binding {
                return key.to_string();
            }
        }
    }
    build_thread_session_key(email)
        .strip_prefix("email:thread:")
        .map(str::to_string)
        .unwrap_or_else(|| email.uid.to_string())
}

fn send_rejection_reply_sync(
    config: &EmailConfig,
    email: &EmailMessage,
    access_token: Option<&str>,
) -> Result<(), String> {
    let msg = "This is an automated response from TeamClu. \
        Your email address is not in the allowed senders list. \
        Please contact the administrator if you believe this is an error.";
    let _ = send_reply_sync(config, email, msg, access_token)?;
    Ok(())
}

// ==================== SMTP Reply (sync) ====================

/// Ensure a Message-ID is wrapped in angle brackets per RFC 2822.
/// e.g., "abc@gmail.com" -> "<abc@gmail.com>"
/// Already-bracketed IDs are returned as-is.
fn ensure_angle_brackets(message_id: &str) -> String {
    let trimmed = message_id.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with('<') && trimmed.ends_with('>') {
        trimmed.to_string()
    } else {
        format!("<{}>", trimmed)
    }
}

/// Wrap each space-separated Message-ID in the References chain with angle brackets.
fn ensure_references_brackets(references: &str) -> String {
    if references.trim().is_empty() {
        return String::new();
    }
    // Split by whitespace and ensure each ID is bracketed
    references
        .split_whitespace()
        .map(ensure_angle_brackets)
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Custom Reply-To header for lettre
#[derive(Clone)]
struct ReplyToHeader(String);

impl lettre::message::header::Header for ReplyToHeader {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Reply-To")
    }

    fn parse(_raw: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(String::new()))
    }

    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// Custom In-Reply-To header for lettre
#[derive(Clone)]
struct InReplyToHeader(String);

impl lettre::message::header::Header for InReplyToHeader {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("In-Reply-To")
    }

    fn parse(_raw: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(String::new()))
    }

    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// Custom References header for lettre
#[derive(Clone)]
struct ReferencesHeader(String);

impl lettre::message::header::Header for ReferencesHeader {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("References")
    }

    fn parse(_raw: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(String::new()))
    }

    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

/// Custom Message-ID header for lettre
#[derive(Clone)]
struct MessageIdHeader(String);

impl lettre::message::header::Header for MessageIdHeader {
    fn name() -> lettre::message::header::HeaderName {
        lettre::message::header::HeaderName::new_from_ascii_str("Message-ID")
    }

    fn parse(_raw: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Ok(Self(String::new()))
    }

    fn display(&self) -> lettre::message::header::HeaderValue {
        lettre::message::header::HeaderValue::new(Self::name(), self.0.clone())
    }
}

fn send_reply_sync(
    config: &EmailConfig,
    original: &EmailMessage,
    reply_body: &str,
    access_token: Option<&str>,
) -> Result<String, String> {
    use lettre::{
        message::{Mailbox, Message, SinglePart},
        Transport,
    };

    // Use shared helpers for SMTP params, From mailbox, and transport
    let params = resolve_smtp_params(config);
    println!(
        "[Email] Reply From address: {} (base: {})",
        params.from_email, params.base_email
    );

    let (from_mailbox, needs_reply_to) = build_from_mailbox(config, &params)?;

    let reply_subject = if original.subject.to_lowercase().starts_with("re:") {
        original.subject.clone()
    } else {
        format!("Re: {}", original.subject)
    };

    // Build the References header to chain the entire email thread.
    // RFC 2822: References should contain the Message-IDs of all preceding messages
    // in the thread. We append the current message's Message-ID to the existing
    // References chain (or start a new chain if References is empty).
    let references = if original.references.is_empty() {
        original.message_id.clone()
    } else if !original.message_id.is_empty() {
        format!("{} {}", original.references, original.message_id)
    } else {
        original.references.clone()
    };

    let to_mailbox: Mailbox = original
        .from
        .parse()
        .map_err(|e| format!("Invalid to address: {}", e))?;

    let mut builder = Message::builder()
        .from(from_mailbox)
        .to(to_mailbox)
        .subject(&reply_subject);

    // Add Reply-To header with the alias address, so that even if Gmail SMTP
    // rewrites the From header, the Reply-To ensures replies go to the alias.
    if needs_reply_to {
        builder = builder.header(ReplyToHeader(params.from_email.clone()));
    }

    // Use base_email for message-id domain (alias doesn't affect the domain)
    let outgoing_message_id = generate_outgoing_message_id(&params.base_email);
    builder = builder.header(MessageIdHeader(outgoing_message_id.clone()));

    // Set In-Reply-To with proper angle brackets per RFC 2822.
    if !original.message_id.is_empty() {
        let in_reply_to = ensure_angle_brackets(&original.message_id);
        builder = builder.header(InReplyToHeader(in_reply_to.clone()));
        println!("[Email] In-Reply-To: {}", in_reply_to);
    }
    // Set References with proper angle brackets for each Message-ID in the chain.
    if !references.is_empty() {
        let refs_bracketed = ensure_references_brackets(&references);
        println!("[Email] References: {}", refs_bracketed);
        builder = builder.header(ReferencesHeader(refs_bracketed));
    }

    let email = builder
        .singlepart(SinglePart::plain(reply_body.to_string()))
        .map_err(|e| format!("Failed to build email: {}", e))?;

    let mailer = build_smtp_transport(config, &params, access_token)?;
    mailer
        .send(&email)
        .map_err(|e| format!("SMTP send failed: {}", e))?;

    Ok(normalize_message_id(&outgoing_message_id))
}

// ==================== Shared SMTP Helpers ====================
// Shared helper functions used by both send_reply_sync (gateway) and
// send_notification_email_sync (cron delivery). Adding features here
// (alias, display name, auth) automatically benefits both paths.

/// Resolved SMTP parameters for sending an email.
struct SmtpParams {
    /// SMTP server hostname
    server: String,
    /// SMTP server port
    port: u16,
    /// Base email address (before alias transformation)
    base_email: String,
    /// Final From email address (may include +alias)
    from_email: String,
}

/// Resolve SMTP connection parameters and From address from EmailConfig.
/// Handles Gmail vs Custom provider and optional +alias.
fn resolve_smtp_params(config: &EmailConfig) -> SmtpParams {
    let (server, port, base_email) = match config.provider {
        EmailProvider::Gmail => (
            GMAIL_SMTP_SERVER.to_string(),
            GMAIL_SMTP_PORT,
            config.gmail_email.clone(),
        ),
        EmailProvider::Custom => (
            config.smtp_server.clone(),
            config.smtp_port,
            config.username.clone(),
        ),
    };

    // Apply +alias if configured, so user replies are routed back to the alias address.
    let from_email = if !config.recipient_alias.trim().is_empty() {
        build_expected_alias_recipient(config).unwrap_or(base_email.clone())
    } else {
        base_email.clone()
    };

    SmtpParams {
        server,
        port,
        base_email,
        from_email,
    }
}

/// Build a From Mailbox with optional display name and Reply-To alias support.
/// Returns (from_mailbox, needs_reply_to) where needs_reply_to is true when
/// from_email differs from base_email (i.e., alias is used).
fn build_from_mailbox(
    config: &EmailConfig,
    params: &SmtpParams,
) -> Result<(lettre::message::Mailbox, bool), String> {
    use lettre::message::Mailbox;

    let from_mailbox: Mailbox = if !config.display_name.trim().is_empty() {
        let addr: lettre::Address = params
            .from_email
            .parse()
            .map_err(|e| format!("Invalid from address: {}", e))?;
        Mailbox::new(Some(config.display_name.trim().to_string()), addr)
    } else {
        params
            .from_email
            .parse()
            .map_err(|e| format!("Invalid from address: {}", e))?
    };

    let needs_reply_to = params.from_email != params.base_email;
    Ok((from_mailbox, needs_reply_to))
}

/// Build an SMTP transport with proper authentication (Gmail XOAUTH2 or Custom credentials).
fn build_smtp_transport(
    config: &EmailConfig,
    params: &SmtpParams,
    access_token: Option<&str>,
) -> Result<lettre::SmtpTransport, String> {
    use lettre::{
        transport::smtp::authentication::{Credentials, Mechanism},
        SmtpTransport,
    };

    match config.provider {
        EmailProvider::Gmail => {
            let token = access_token.ok_or(
                "Gmail SMTP requires OAuth2 access token but none available. Please authorize Gmail first."
            )?;
            let creds = Credentials::new(config.gmail_email.clone(), token.to_string());
            Ok(SmtpTransport::starttls_relay(&params.server)
                .map_err(|e| format!("SMTP relay failed: {}", e))?
                .port(params.port)
                .credentials(creds)
                .authentication(vec![Mechanism::Xoauth2])
                .build())
        }
        EmailProvider::Custom => {
            let creds = Credentials::new(config.username.clone(), config.password.clone());
            // Port 465 uses implicit TLS (relay), other ports try STARTTLS first
            // then fall back to implicit TLS if STARTTLS fails.
            if params.port == 465 {
                println!("[Email] SMTP: using implicit TLS (port 465)");
                Ok(SmtpTransport::relay(&params.server)
                    .map_err(|e| format!("SMTP relay failed: {}", e))?
                    .port(params.port)
                    .credentials(creds)
                    .build())
            } else {
                // Try STARTTLS first, fall back to implicit TLS
                match SmtpTransport::starttls_relay(&params.server) {
                    Ok(builder) => {
                        println!("[Email] SMTP: using STARTTLS (port {})", params.port);
                        Ok(builder.port(params.port).credentials(creds).build())
                    }
                    Err(starttls_err) => {
                        println!(
                            "[Email] SMTP: STARTTLS failed ({}), falling back to implicit TLS",
                            starttls_err
                        );
                        Ok(SmtpTransport::relay(&params.server)
                            .map_err(|e| format!("SMTP relay (fallback) failed: {}", e))?
                            .port(params.port)
                            .credentials(creds)
                            .build())
                    }
                }
            }
        }
    }
}

// ==================== Utility Functions ====================

fn generate_outgoing_message_id(from_email: &str) -> String {
    let domain = from_email
        .split_once('@')
        .map(|(_, d)| d)
        .unwrap_or("localhost");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id();
    format!("<teamclu-{}-{}@{}>", now, pid, domain)
}

/// Check if a line is a quote attribution line (the "On ... wrote:" header).
/// Supports multiple languages and email client formats:
/// - English: "On Feb 12, 2026, at 00:10, Name <email> wrote:"
/// - Chinese: "Name <email> 于2026年2月12日周四 00:10写道："
/// - Generic: line contains "<email>" and ends with a colon-like pattern
fn is_quote_attribution(line: &str) -> bool {
    let trimmed = line.trim();

    // English: "On ... wrote:"
    if trimmed.starts_with("On ") && trimmed.contains(" wrote:") {
        return true;
    }

    // Chinese: contains "写道：" or "写道:"
    if trimmed.contains("写道：") || trimmed.contains("写道:") {
        return true;
    }

    // Japanese: "に書きました:"
    if trimmed.contains("に書きました") {
        return true;
    }

    // Generic heuristic: line contains an email in angle brackets AND ends with ":"
    // e.g., "Some Name <foo@bar.com> on 2026-02-12 wrote:" or similar
    if trimmed.contains('<') && trimmed.contains('@') && trimmed.contains('>') {
        let ends_with_colon = trimmed.ends_with(':')
            || trimmed.ends_with("：")  // fullwidth colon
            || trimmed.ends_with(": ");
        if ends_with_colon {
            return true;
        }
    }

    // German: "schrieb:" / French: "a écrit :" / Spanish: "escribió:"
    if trimmed.ends_with("schrieb:")
        || trimmed.contains("a écrit")
        || trimmed.ends_with("escribió:")
    {
        return true;
    }

    false
}

fn clean_email_body(body: &str) -> String {
    let mut lines: Vec<&str> = Vec::new();
    let mut in_quoted = false;

    for line in body.lines() {
        // Detect start of quoted section
        if line.starts_with('>') || is_quote_attribution(line) {
            in_quoted = true;
            continue;
        }
        // Signature delimiter
        if line.trim() == "--" || line.trim() == "-- " {
            break;
        }
        // Gmail sometimes uses a blank line between the reply and the quote.
        // If we're in quoted mode and see a non-quoted line, check if it's
        // just a blank line within the quote block.
        if in_quoted {
            // If we see a non-empty, non-quoted line after entering quoted mode,
            // it's likely still part of the quote (wrapped lines without '>').
            // Only reset if we see substantial new content without quote markers.
            if line.trim().is_empty() {
                continue;
            }
            // Still in quoted block - skip
            continue;
        }
        lines.push(line);
    }

    let result = lines.join("\n").trim().to_string();
    if result.is_empty() {
        // Fallback: if cleaning removed everything, return raw body (truncated)
        body.chars().take(2000).collect()
    } else {
        result
    }
}

// ==================== Reusable Send Utility ====================
// Standalone function for sending notification emails.
// Handles both Gmail (OAuth2/XOAUTH2) and Custom SMTP providers.
// Used by cron delivery and potentially other modules.

/// Send a standalone notification email.
/// Properly handles Gmail OAuth2 (XOAUTH2) and custom SMTP authentication.
///
/// The outgoing Message-ID is set on the wire but not returned: nothing indexes
/// it. Replies to mail sent this way do NOT resolve back to a session — see the
/// note at the Message-ID header below.
pub async fn send_notification_email(
    config: &EmailConfig,
    workspace_path: &str,
    to_addr: &str,
    subject: &str,
    body_text: &str,
) -> Result<(), String> {
    // Get access token for Gmail OAuth2 (async, must happen before spawn_blocking)
    let access_token = if config.provider == EmailProvider::Gmail {
        let token_manager = GmailTokenManager::new(
            &config.gmail_client_id,
            &config.gmail_client_secret,
            &config.gmail_email,
            workspace_path,
        );
        Some(token_manager.get_access_token().await?)
    } else {
        None
    };

    // Clone data for the blocking task
    let config = config.clone();
    let to_addr = to_addr.to_string();
    let subject = subject.to_string();
    let body_text = body_text.to_string();

    tokio::task::spawn_blocking(move || {
        send_notification_email_sync(
            &config,
            access_token.as_deref(),
            &to_addr,
            &subject,
            &body_text,
        )
    })
    .await
    .map_err(|e| format!("Email task panicked: {}", e))?
}

/// Synchronous helper for sending a notification email via SMTP.
/// Uses shared helpers (resolve_smtp_params, build_from_mailbox, build_smtp_transport)
/// so it automatically inherits display_name, alias, and auth features from the gateway.
fn send_notification_email_sync(
    config: &EmailConfig,
    access_token: Option<&str>,
    to: &str,
    subject: &str,
    body: &str,
) -> Result<(), String> {
    use lettre::{
        message::{Mailbox, Message},
        Transport,
    };

    // Use shared helpers — same logic as gateway reply
    let params = resolve_smtp_params(config);
    let (from_mailbox, needs_reply_to) = build_from_mailbox(config, &params)?;

    println!(
        "[Email] Notification From: {} (base: {})",
        params.from_email, params.base_email
    );

    let to_mailbox: Mailbox = to.parse().map_err(|e| format!("Invalid to email: {}", e))?;

    let mut builder = Message::builder()
        .from(from_mailbox)
        .to(to_mailbox)
        .subject(subject);

    // Add Reply-To with alias address so user replies go to the alias
    // (same behavior as gateway reply emails)
    if needs_reply_to {
        builder = builder.header(ReplyToHeader(params.from_email.clone()));
    }

    // Generate and set Message-ID header (same as gateway reply) so the
    // recipient's client threads the conversation.
    //
    // Note this id is NOT indexed: `EmailDb::store_message_thread` is only
    // called from the inbound reply path (`process_and_reply_sync`), so a reply
    // to mail sent through here misses both the message-id and the subject
    // index and lands in a fresh session. A dead `SessionMapping` registration
    // used to sit at the cron call site pretending otherwise; it was removed
    // rather than left as a decoy. Wiring this up needs an account_key and a
    // session binding that the cron path does not have — see #933.
    let outgoing_message_id = generate_outgoing_message_id(&params.base_email);
    builder = builder.header(MessageIdHeader(outgoing_message_id.clone()));

    let email = builder
        .body(body.to_string())
        .map_err(|e| format!("Failed to build email: {}", e))?;

    let mailer = build_smtp_transport(config, &params, access_token)?;
    mailer
        .send(&email)
        .map_err(|e| format!("SMTP send failed: {}", e))?;

    println!(
        "[Email] Notification sent to {} (message-id: {})",
        to, outgoing_message_id
    );
    Ok(())
}
