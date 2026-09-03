use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Manager, Runtime};

/// Safari user agent matching the actual WKWebView engine.
/// Chrome UA causes blank pages — servers may return Chrome-specific responses
/// (e.g. Brotli encoding, different JS bundles) that WKWebView can't handle.
const WEBVIEW_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";
const EXTERNAL_WEBVIEW_INIT_SCRIPT: &str = r#"(function(){
  // Tauri notification plugin defines Notification.permission as readonly and throws
  // on direct assignment. Some external sites attempt this write and would otherwise
  // surface noisy unhandled rejections inside embedded webviews.
  function suppressReadonlyPermissionError(evt) {
    try {
      var reason = evt && evt.reason;
      var message = reason && reason.message ? String(reason.message) : String(reason || '');
      if (message !== 'Readonly property' && message !== 'Error: Readonly property') {
        return;
      }
      var stack = reason && reason.stack ? String(reason.stack) : '';
      if (stack && stack.indexOf('notification') === -1 && stack.indexOf('user-script') === -1) {
        return;
      }
      evt.preventDefault();
    } catch (_) {}
  }

  window.addEventListener('unhandledrejection', suppressReadonlyPermissionError, true);

  function installSafeNotificationWrapper() {
    try {
      if (!window.Notification) return;

      function wrapNotification(candidate) {
        if (typeof candidate !== 'function' || candidate.__TEAMCLU_SAFE_NOTIFICATION__) {
          return candidate;
        }

        var permission = 'default';
        try {
          permission = candidate.permission == null ? 'default' : String(candidate.permission);
        } catch (_) {}

        function SafeNotification(title, options) {
          try {
            return new candidate(title, options);
          } catch (_) {
            return candidate.apply(this, arguments);
          }
        }

        try { SafeNotification.prototype = candidate.prototype; } catch (_) {}
        try {
          Object.getOwnPropertyNames(candidate).forEach(function(key) {
            if (key === 'permission' || key === 'prototype' || key === 'length' || key === 'name') {
              return;
            }
            try {
              Object.defineProperty(SafeNotification, key, Object.getOwnPropertyDescriptor(candidate, key));
            } catch (_) {}
          });
        } catch (_) {}

        Object.defineProperty(SafeNotification, 'permission', {
          enumerable: true,
          configurable: true,
          get: function() { return permission; },
          set: function(next) {
            permission = next == null ? 'default' : String(next);
            try { candidate.permission = next; } catch (_) {}
          }
        });
        Object.defineProperty(SafeNotification, '__TEAMCLU_SAFE_NOTIFICATION__', {
          value: true,
          configurable: false
        });
        return SafeNotification;
      }

      var currentNotification = wrapNotification(window.Notification);
      Object.defineProperty(window, 'Notification', {
        enumerable: true,
        configurable: true,
        get: function() { return currentNotification; },
        set: function(next) { currentNotification = wrapNotification(next); }
      });
    } catch (_) {}
  }

  installSafeNotificationWrapper();

  function navigateHere(href) {
    try {
      window.top.location.href = href;
    } catch (_) {
      window.location.href = href;
    }
  }
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a');
    if (!a) return;
    var t = a.getAttribute('target');
    if (t && t !== '_self') {
      var href = a.href || a.getAttribute('href');
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        navigateHere(href);
      }
    }
  }, true);
  var _open = window.open;
  var _interceptOpen = function(url) {
    if (url && /^https?:\/\//.test(String(url))) {
      navigateHere(String(url));
      return window;
    }
    return _open.apply(this, arguments);
  };
  try {
    Object.defineProperty(window, 'open', {
      value: _interceptOpen, writable: true, configurable: true
    });
  } catch (_) {}
})();"#;

/// Send-safe wrapper around a retained ObjC WKWebViewConfiguration pointer.
#[cfg(target_os = "macos")]
pub struct SharedConfig(*const std::ffi::c_void);
#[cfg(target_os = "macos")]
unsafe impl Send for SharedConfig {}
#[cfg(target_os = "macos")]
unsafe impl Sync for SharedConfig {}

#[cfg(target_os = "macos")]
impl Drop for SharedConfig {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { objc2::ffi::objc_release(self.0 as *mut _) };
        }
    }
}

/// State to track child webview labels.
pub struct WebviewManager {
    pub labels: Mutex<HashMap<String, ()>>,
    /// Shared WKWebViewConfiguration so all external webviews share the same
    /// WKProcessPool (in-memory cookies) and WKWebsiteDataStore (persistent cookies).
    #[cfg(target_os = "macos")]
    pub shared_config: Option<SharedConfig>,
}

impl Default for WebviewManager {
    fn default() -> Self {
        Self {
            labels: Mutex::new(HashMap::new()),
            #[cfg(target_os = "macos")]
            shared_config: None,
        }
    }
}

fn build_teamclu_identity_script(device_no: &str, device_name: &str) -> String {
    let escaped_no = serde_json::to_string(device_no).unwrap_or_else(|_| "\"\"".to_string());
    let escaped_name = serde_json::to_string(device_name).unwrap_or_else(|_| "\"\"".to_string());

    format!(
        r#"(function(){{
  // deviceToken (master-data-api JWT) was seeded by the removed random-hex
  // device identity; the getter is kept on window.teamclu but is always null.
  var __next = {{ deviceNo: {no}, deviceName: {name}, deviceToken: null }};
  if (typeof window.__TEAMCLU_SET_IDENTITY__ !== 'function') {{
    var __state = {{ deviceNo: '', deviceName: '', deviceToken: null }};
    Object.defineProperty(window, '__TEAMCLU_SET_IDENTITY__', {{
      value: function(next) {{
        __state.deviceNo = next && next.deviceNo ? next.deviceNo : '';
        __state.deviceName = next && next.deviceName ? next.deviceName : '';
        __state.deviceToken = next ? next.deviceToken : null;
      }},
      writable: false,
      enumerable: false,
      configurable: true
    }});
    // Capture native Storage methods before any page script can monkey-patch them.
    // Pages that detect window.teamclu sometimes wrap localStorage in a way that
    // breaks keys containing hyphens (e.g. "active-eruda"). Binding to
    // Storage.prototype here — at document start — preserves the original behaviour.
    var __nativeStorage;
    try {{
      var __si = Storage.prototype.setItem;
      var __gi = Storage.prototype.getItem;
      var __ri = Storage.prototype.removeItem;
      var __cl = Storage.prototype.clear;
      __nativeStorage = Object.freeze({{
        setItem:    function(k, v) {{ return __si.call(localStorage, k, v); }},
        getItem:    function(k)    {{ return __gi.call(localStorage, k);    }},
        removeItem: function(k)    {{ return __ri.call(localStorage, k);    }},
        clear:      function()     {{ return __cl.call(localStorage);       }},
      }});
    }} catch(_) {{
      __nativeStorage = null;
    }}
    Object.defineProperty(window, 'teamclu', {{
      value: Object.freeze({{
        get deviceNo() {{ return __state.deviceNo; }},
        get deviceName() {{ return __state.deviceName; }},
        get deviceToken() {{ return __state.deviceToken; }},
        get nativeStorage() {{ return __nativeStorage; }},
      }}),
      writable: false,
      enumerable: true,
      configurable: true
    }});
  }}
  window.__TEAMCLU_SET_IDENTITY__(__next);
}})();"#,
        no = escaped_no,
        name = escaped_name,
    )
}

/// `scheme://host[:port]`, the unit identity injection is scoped to.
fn origin_key(url: &tauri::Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
        None => format!("{}://{}", url.scheme(), host),
    }
}

/// The origin `window.teamclu` may be injected into for a tab opened at `url`,
/// or `None` when the page must not learn who is looking at it.
///
/// Trusted: the Cloud API host baked at build time, the admin console the
/// frontend vetted for SSO injection (`admin_console_vetted`), and loopback for
/// development. Anything else — a partner site, a link from a chat message, an
/// OAuth provider — gets nothing. Non-loopback origins must be https so the
/// identity is never handed over a plaintext hop.
fn identity_injection_origin(url: &tauri::Url, admin_console_vetted: bool) -> Option<String> {
    let host = url.host_str()?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    let cloud_api_host = option_env!("CLOUD_API_URL")
        .and_then(|raw| tauri::Url::parse(raw.trim()).ok())
        .and_then(|u| u.host_str().map(str::to_string));
    let trusted = admin_console_vetted || loopback || cloud_api_host.as_deref() == Some(host);
    if !trusted || (url.scheme() != "https" && !loopback) {
        return None;
    }
    Some(origin_key(url))
}

/// Reject http(s) URLs whose host cannot be resolved before handing them to
/// WKWebView / WebView2. Loading an unresolvable `WebviewUrl::External` has
/// been observed to freeze the AppKit main thread on macOS (window undraggable,
/// no clicks anywhere) — see GitHub issue #617.
fn ensure_http_host_resolvable(url: &tauri::Url) -> Result<(), String> {
    use std::net::ToSocketAddrs;

    if !matches!(url.scheme(), "http" | "https") {
        return Ok(());
    }

    let Some(host) = url.host_str() else {
        return Err(format!("URL missing host: {url}"));
    };

    // IP literals need no DNS lookup.
    if matches!(
        url.host(),
        Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_))
    ) {
        return Ok(());
    }

    let port = url
        .port_or_known_default()
        .unwrap_or(if url.scheme() == "https" { 443 } else { 80 });
    let addr = format!("{host}:{port}");
    match addr.to_socket_addrs() {
        Ok(mut iter) => {
            if iter.next().is_some() {
                Ok(())
            } else {
                Err(format!("Host '{host}' did not resolve"))
            }
        }
        Err(err) => Err(format!("Host '{host}' could not be resolved: {err}")),
    }
}

async fn ensure_http_host_resolvable_async(url: &tauri::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Ok(());
    }
    // IP literals: cheap sync path, no DNS.
    if matches!(
        url.host(),
        Some(url::Host::Ipv4(_)) | Some(url::Host::Ipv6(_))
    ) {
        return Ok(());
    }

    let url = url.clone();
    let host = url.host_str().unwrap_or("?").to_string();
    let joined = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        tokio::task::spawn_blocking(move || ensure_http_host_resolvable(&url)),
    )
    .await;

    match joined {
        Ok(Ok(inner)) => inner,
        Ok(Err(join_err)) => Err(format!("Host '{host}' check failed: {join_err}")),
        Err(_) => Err(format!("Host '{host}' resolution timed out")),
    }
}

/// Build a documentStart script that seeds a supabase-js session into the
/// page's localStorage so it is already authenticated when its bundle runs.
/// `session_json` is the already-serialized supabase session object; it is
/// written under `storage_key` only when absent, so supabase-js's own
/// refreshed session is never clobbered on reload.
fn build_supabase_session_script(storage_key: &str, session_json: &str) -> String {
    let key_lit = serde_json::to_string(storage_key).unwrap_or_else(|_| "\"\"".to_string());
    let val_lit = serde_json::to_string(session_json).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function(){{
  try {{
    var k = {key};
    if (!localStorage.getItem(k)) {{
      localStorage.setItem(k, {val});
    }}
  }} catch (_e) {{}}
}})();"#,
        key = key_lit,
        val = val_lit,
    )
}

/// Build a documentStart script that clears a stale supabase-js session from
/// the page's localStorage exactly once per webview session, forcing a fresh
/// authenticated login. Used by Web SSO: the webview shares a persistent data
/// store, so a previous admin-console session lingers in localStorage — and its
/// refresh token was already rotated/consumed when TeamClu adopted it, so reusing it
/// fails with "refresh token not found". The sessionStorage flag ensures we only
/// clear on the initial load, never wiping the session the user just signed into
/// after a post-login redirect.
fn build_clear_session_script(storage_key: &str) -> String {
    let key_lit = serde_json::to_string(storage_key).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        r#"(function(){{
  try {{
    if (!sessionStorage.getItem('__teamclu_websso_cleared')) {{
      sessionStorage.setItem('__teamclu_websso_cleared', '1');
      localStorage.removeItem({key});
    }}
  }} catch (_e) {{}}
}})();"#,
        key = key_lit,
    )
}

/// Build a JS expression that returns the string value at `key` in
/// localStorage (or null when absent). Used to harvest a webview's
/// supabase-js session out of its own localStorage.
fn build_read_local_storage_js(key: &str) -> String {
    let key_lit = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
    format!("(function(){{ try {{ return localStorage.getItem({key}); }} catch (_e) {{ return null; }} }})()", key = key_lit)
}

#[cfg(target_os = "macos")]
fn add_document_start_script<R: Runtime>(webview: &tauri::Webview<R>, script: &str) {
    let script = script.to_string();
    if let Err(e) = webview.with_webview(move |wv| {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use std::ffi::CString;

        let Ok(script) = CString::new(script) else {
            return;
        };

        unsafe {
            let wk_webview: *const AnyObject = wv.inner().cast();
            let config: *const AnyObject = msg_send![wk_webview, configuration];
            if config.is_null() {
                return;
            }
            let controller: *const AnyObject = msg_send![config, userContentController];
            if controller.is_null() {
                return;
            }
            let source: *const AnyObject =
                msg_send![class!(NSString), stringWithUTF8String: script.as_ptr()];
            if source.is_null() {
                return;
            }
            let allocated: *mut AnyObject = msg_send![class!(WKUserScript), alloc];
            if allocated.is_null() {
                return;
            }
            let user_script: *mut AnyObject = msg_send![
                allocated,
                initWithSource: source,
                injectionTime: 0isize,
                forMainFrameOnly: true
            ];
            if user_script.is_null() {
                return;
            }
            let _: () = msg_send![controller, addUserScript: user_script];
            objc2::ffi::objc_release(user_script as *mut _);
        }
    }) {
        log::error!("[Webview] Failed to refresh document-start identity script: {e}");
    }
}

#[cfg(not(target_os = "macos"))]
fn add_document_start_script<R: Runtime>(_webview: &tauri::Webview<R>, _script: &str) {}

/// Create a shared WKWebViewConfiguration on the main thread.
/// Must be called from Tauri's builder chain or setup() which run on the main thread.
///
/// All child webviews share this configuration, which means they share:
/// - WKProcessPool → session cookies shared in-memory across webviews
/// - WKWebsiteDataStore (defaultDataStore) → persistent cookies, localStorage shared
#[cfg(target_os = "macos")]
pub fn init_shared_config(manager: &mut WebviewManager) {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, MainThreadMarker};
    use objc2_web_kit::{WKWebViewConfiguration, WKWebsiteDataStore};

    let mtm =
        MainThreadMarker::new().expect("init_shared_config must be called from the main thread");
    unsafe {
        let config = WKWebViewConfiguration::new(mtm);
        // Explicitly set the default persistent data store so cookies/localStorage
        // are shared with all webviews using this config.
        // Note: WKProcessPool is deprecated/no-op on modern macOS — all webviews
        // share a single global process pool automatically.
        let data_store = WKWebsiteDataStore::defaultDataStore(mtm);
        config.setWebsiteDataStore(&data_store);

        // Keep Safari Web Inspector available in release builds too.
        // If this causes layout issues in specific scenarios, users can disable
        // it via TEAMCLU_DISABLE_WEBVIEW_DEVTOOLS=1 when launching the app.
        let prefs = config.preferences();
        let prefs_ptr: *mut AnyObject = objc2::rc::Retained::as_ptr(&prefs) as *mut AnyObject;
        let disable_devtools = std::env::var("TEAMCLU_DISABLE_WEBVIEW_DEVTOOLS")
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
            .unwrap_or(false);
        let ns_bool: *mut AnyObject =
            msg_send![class!(NSNumber), numberWithBool: !disable_devtools];
        let key_str = std::ffi::CString::new("developerExtrasEnabled").unwrap();
        let key_ns: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: key_str.as_ptr()];
        let _: () = msg_send![prefs_ptr, setValue: ns_bool, forKey: key_ns];

        let raw = objc2::rc::Retained::as_ptr(&config) as *const std::ffi::c_void;
        objc2::ffi::objc_retain(raw as *mut _);
        manager.shared_config = Some(SharedConfig(raw));
    }
    log::info!(
        "[Webview] Shared WKWebViewConfiguration initialized on main thread (defaultDataStore + shared pool, devtools enabled by default)"
    );
}

/// Create a native webview as a child of the calling window at the given position.
///
/// When `device_no` and `device_name` are provided, a `window.teamclu` global
/// is injected into the webview before any page scripts run, exposing identity
/// information for the current team member.
#[tauri::command]
pub async fn webview_create(
    app: tauri::AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, WebviewManager>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    device_no: Option<String>,
    device_name: Option<String>,
    auth_storage_key: Option<String>,
    auth_session_json: Option<String>,
    clear_storage_key: Option<String>,
) -> Result<(), String> {
    // If webview with this label already exists, just show and reposition it
    let exists = state
        .labels
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&label);
    if exists {
        if let Some(webview) = app.get_webview(&label) {
            log::info!(
                "[Webview] Reusing existing '{}', showing and repositioning",
                label
            );
            let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
            let _ = webview.set_size(tauri::LogicalSize::new(width, height));
            let _ = webview.show();
            let _ = webview.set_focus();
            return Ok(());
        } else {
            // Label tracked but webview gone — clean up
            state
                .labels
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&label);
        }
    }

    let parsed_url = url
        .parse::<tauri::Url>()
        .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;

    // Fail closed before add_child: unresolvable External URLs can freeze the
    // AppKit main thread (issue #617).
    ensure_http_host_resolvable_async(&parsed_url).await?;

    log::info!(
        "[Webview] Creating '{}' in parent '{}' url={} pos=({},{}) size={}x{}",
        label,
        window.label(),
        url,
        x,
        y,
        width,
        height
    );

    // Partner admin console auto-login: seed the current TeamClu session into
    // the page's supabase-js localStorage key.
    //
    // The host check lives entirely on the caller side (adminSsoInjectionFor),
    // which only returns a key + session when the URL matches the admin host
    // the Cloud API declared via WEBSSO_LOGIN_URL. There used to be a second,
    // compile-time allowlist here (WEBSSO_ADMIN_HOSTS, baked from
    // features.auth.webSSOHosts) — but it was a hand-maintained copy of that
    // same host, and the two drifting apart made injection fail silently. One
    // source of truth beats a duplicate that has to be kept in step.
    let auth_inject_script = match (auth_storage_key.as_deref(), auth_session_json.as_deref()) {
        (Some(key), Some(session)) if !key.is_empty() && !session.is_empty() => {
            Some(build_supabase_session_script(key, session))
        }
        _ => None,
    };

    // Web SSO: clear any stale supabase-js session at documentStart so the user
    // must authenticate fresh (a lingering session's refresh token may already
    // be consumed). The script clears only on the first load (sessionStorage
    // one-shot), so it acts solely on the page we deliberately navigate to —
    // the FC-delivered login URL chosen by the trusted frontend.
    let clear_inject_script = match clear_storage_key.as_deref() {
        Some(key) if !key.is_empty() && parsed_url.host_str().is_some() => {
            Some(build_clear_session_script(key))
        }
        _ => None,
    };

    // SEC-7: `window.teamclu` (device id, display name) goes only into origins
    // we trust — the Cloud API host baked at build time, the admin console the
    // frontend just vetted for SSO injection, or loopback in dev — and only
    // while the page stays on the origin it was opened at. Before this, every
    // page a tab navigated to, first- or third-party, received it on each load.
    let identity_origin = identity_injection_origin(&parsed_url, auth_inject_script.is_some());

    #[allow(unused_mut)]
    let mut webview_builder =
        tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url))
            .user_agent(WEBVIEW_UA);

    // On macOS, use the shared WKWebViewConfiguration so all webviews share
    // the same WKProcessPool → cookies/session shared instantly across tabs.
    #[cfg(target_os = "macos")]
    if let Some(ref shared) = state.shared_config {
        unsafe {
            use objc2::rc::Retained;
            use objc2_web_kit::WKWebViewConfiguration;

            let config_ptr = shared.0 as *mut WKWebViewConfiguration;
            let config: Retained<WKWebViewConfiguration> = Retained::retain(config_ptr)
                .expect("Shared WKWebViewConfiguration should be valid");
            webview_builder = webview_builder.with_webview_configuration(config);
            log::info!("[Webview] Using shared WKWebViewConfiguration");
        }
    }

    // Intercept target="_blank" links and window.open() so OAuth popups
    // remain in the same native webview. Run in all frames because OAuth
    // widgets often live inside iframes.
    webview_builder =
        webview_builder.initialization_script_for_all_frames(EXTERNAL_WEBVIEW_INIT_SCRIPT);

    // Native fallback for popup requests that bypass our JS hook.
    {
        let popup_label = label.clone();
        let popup_app = app.clone();
        webview_builder = webview_builder.on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                log::info!(
                    "[Webview] Redirecting popup request for '{}' to {}",
                    popup_label,
                    url
                );
                if let Some(webview) = popup_app.get_webview(&popup_label) {
                    let _ = webview.navigate(url.clone());
                }
            }
            tauri::webview::NewWindowResponse::Deny
        });
    }

    // Inject as long as we have a device ID and the origin is trusted. Device
    // name is a display-only string — empty is fine and must not block the shim.
    let identity = device_no
        .as_deref()
        .filter(|dno| !dno.is_empty())
        .filter(|_| identity_origin.is_some())
        .map(|dno| (dno.to_string(), device_name.clone().unwrap_or_default()));
    let initial_identity_script = identity
        .as_ref()
        .map(|(dno, dname)| build_teamclu_identity_script(dno, dname));

    // Page load progress via on_page_load callback (no JS injection needed —
    // child webviews don't have __TAURI_INTERNALS__)
    {
        let progress_label = label.clone();
        let identity = identity.clone();
        let identity_origin = identity_origin.clone();
        let auth_script = auth_inject_script.clone();
        let clear_script = clear_inject_script.clone();
        webview_builder = webview_builder.on_page_load(move |webview, payload| {
            use tauri::Emitter;
            let progress = match payload.event() {
                tauri::webview::PageLoadEvent::Started => 30,
                tauri::webview::PageLoadEvent::Finished => 100,
            };
            let _ = webview.emit(
                "webview-progress",
                serde_json::json!({
                    "label": progress_label,
                    "progress": progress
                }),
            );

            // A navigation away from the trusted origin (redirect, link, SSO
            // hop) must not carry the identity object with it.
            let on_trusted_origin = webview.url().ok().map(|u| origin_key(&u)) == identity_origin;
            if let (Some((device_no, device_name)), true) = (&identity, on_trusted_origin) {
                let script = build_teamclu_identity_script(device_no, device_name);
                match payload.event() {
                    tauri::webview::PageLoadEvent::Started => {
                        add_document_start_script(&webview, &script);
                    }
                    tauri::webview::PageLoadEvent::Finished => {
                        let _ = webview.eval(&script);
                    }
                }
            }

            // Re-seed the supabase session at documentStart on every (re)load so
            // a hard refresh of the admin SPA stays authenticated.
            if let Some(script) = &auth_script {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    add_document_start_script(&webview, script);
                }
            }

            // Web SSO: clear the stale session at documentStart (the script's own
            // sessionStorage guard makes it a one-shot, so the post-login session
            // isn't wiped on redirect).
            if let Some(script) = &clear_script {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                    add_document_start_script(&webview, script);
                }
            }
        });
    }

    // Right-click: rely on the native WKWebView / WebView2 context menu.
    // No custom init script needed — native menus provide Copy/Paste/Look Up/etc.

    // Inject window.teamclu before page scripts run. The object is stable but
    // its getters read refreshed values after OAuth redirects and page reloads.
    if let Some(script) = initial_identity_script {
        webview_builder = webview_builder.initialization_script(&script);
    }

    // Seed the supabase session before the admin SPA's bundle runs, so
    // supabase-js picks up the logged-in TeamClu session on init.
    if let Some(ref script) = auth_inject_script {
        webview_builder = webview_builder.initialization_script(script);
    }

    // Web SSO: clear any stale session before the admin SPA's bundle runs so it
    // boots logged-out and the user authenticates fresh.
    if let Some(ref script) = clear_inject_script {
        webview_builder = webview_builder.initialization_script(script);
    }

    let webview = window
        .add_child(
            webview_builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to create webview: {}", e))?;

    // Bring the child webview to front
    let _ = webview.set_focus();

    // Track the label
    state
        .labels
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label.clone(), ());

    log::info!("[Webview] Created successfully: {}", label);
    Ok(())
}

fn webview_close_inner(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, WebviewManager>,
    label: &str,
) {
    state
        .labels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
}

/// Close a native webview by label (destroys it).
#[tauri::command]
pub async fn webview_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, WebviewManager>,
    label: String,
) -> Result<(), String> {
    log::info!("[Webview] Closing: {}", label);
    webview_close_inner(&app, &state, &label);
    Ok(())
}

/// Hide a native webview (keeps it alive, no reload on show).
#[tauri::command]
pub async fn webview_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        log::info!("[Webview] Hiding: {}", label);
        let _ = webview.hide();
    }
    Ok(())
}

/// Show a hidden native webview and bring it to front.
#[tauri::command]
pub async fn webview_show(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        log::info!("[Webview] Showing: {}", label);
        let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
        let _ = webview.set_size(tauri::LogicalSize::new(width, height));
        let _ = webview.show();
        let _ = webview.set_focus();
    }
    Ok(())
}

/// Resize and reposition a native webview.
#[tauri::command]
pub async fn webview_set_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_position(tauri::LogicalPosition::new(x, y));
        let _ = webview.set_size(tauri::LogicalSize::new(width, height));
    }
    Ok(())
}

/// Navigate back in the webview history.
#[tauri::command]
pub async fn webview_go_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.history.back()");
    }
    Ok(())
}

/// Navigate forward in the webview history.
#[tauri::command]
pub async fn webview_go_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.history.forward()");
    }
    Ok(())
}

/// Reload the webview.
#[tauri::command]
pub async fn webview_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.location.reload()");
    }
    Ok(())
}

/// Navigate a webview to a new URL.
#[tauri::command]
pub async fn webview_navigate(
    app: tauri::AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let parsed = url
            .parse::<tauri::Url>()
            .map_err(|e| format!("Invalid URL '{}': {}", url, e))?;
        // Same guard as webview_create — navigate to a bad host can freeze too.
        ensure_http_host_resolvable_async(&parsed).await?;
        log::info!("[Webview] Navigating '{}' to {}", label, url);
        webview
            .navigate(parsed)
            .map_err(|e| format!("Failed to navigate: {}", e))?;
    }
    Ok(())
}

/// Get the current URL of the webview.
#[tauri::command]
pub async fn webview_get_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    if let Some(webview) = app.get_webview(&label) {
        return webview
            .url()
            .map(|u| u.to_string())
            .map_err(|e| format!("{}", e));
    }
    Err("Webview not found".to_string())
}

/// Get the page title of a child webview via native platform API.
/// Child webviews loading external URLs don't have __TAURI_INTERNALS__,
/// so we read the title directly from the native WKWebView / WebView2.
#[tauri::command]
pub async fn webview_get_title(app: tauri::AppHandle, label: String) -> Result<String, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Webview not found".to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<String>();

    webview
        .with_webview(move |wv| {
            #[cfg(target_os = "macos")]
            {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                unsafe {
                    let wk_webview: *const AnyObject = wv.inner().cast();
                    let ns_title: *const AnyObject = msg_send![wk_webview, title];
                    if !ns_title.is_null() {
                        let utf8: *const std::ffi::c_char = msg_send![ns_title, UTF8String];
                        if !utf8.is_null() {
                            let s = std::ffi::CStr::from_ptr(utf8).to_string_lossy().to_string();
                            let _ = tx.send(s);
                            return;
                        }
                    }
                }
                let _ = tx.send(String::new());
            }
            #[cfg(target_os = "windows")]
            {
                // WebView2: access ICoreWebView2 DocumentTitle via with_webview
                // For now, return empty — will be improved when testing on Windows
                let _ = wv; // suppress unused warning
                let _ = tx.send(String::new());
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = wv;
                let _ = tx.send(String::new());
            }
        })
        .map_err(|e| e.to_string())?;

    // with_webview dispatches to the main thread, wait for result
    match rx.recv_timeout(std::time::Duration::from_secs(2)) {
        Ok(title) => Ok(title),
        Err(_) => Ok(String::new()),
    }
}

/// Read a string value out of a child webview's localStorage.
///
/// Child webviews loading external URLs have no `__TAURI_INTERNALS__`, so we
/// read directly from the native WKWebView via evaluateJavaScript with a
/// completion handler (macOS: `WKWebView evaluateJavaScript`; Windows:
/// `ICoreWebView2::ExecuteScript`). Returns `Ok(None)` when the key is absent /
/// value is JS null, or on any read error. A no-op (`None`) on other platforms.
///
/// Defense in depth: the caller passes the exact host it expects the webview to
/// be on (derived from the FC-delivered Web SSO login URL), and the read only
/// runs when the webview's CURRENT host matches it. So a redirect to another
/// origin — or a careless future caller — can't exfil an arbitrary page's
/// localStorage. An absent/empty `expected_host` reads nothing.
#[tauri::command]
pub async fn webview_read_local_storage(
    app: tauri::AppHandle,
    label: String,
    key: String,
    expected_host: Option<String>,
) -> Result<Option<String>, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "Webview not found".to_string())?;

    // Only harvest when the webview is actually on the caller-declared host.
    let allowed = expected_host.as_deref().filter(|h| !h.is_empty());
    match (allowed, webview.url()) {
        (Some(host), Ok(url)) if url.host_str() == Some(host) => {}
        _ => return Ok(None),
    }

    let js = build_read_local_storage_js(&key);

    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    webview
        .with_webview(move |wv| {
            #[cfg(target_os = "macos")]
            {
                use block2::RcBlock;
                use objc2::msg_send;
                use objc2::runtime::AnyObject;
                use std::ffi::CString;

                unsafe {
                    let wk_webview: *mut AnyObject = wv.inner().cast();
                    let Ok(src) = CString::new(js.clone()) else {
                        let _ = tx.send(None);
                        return;
                    };
                    let ns_src: *mut AnyObject =
                        msg_send![objc2::class!(NSString), stringWithUTF8String: src.as_ptr()];

                    // completion: (id result, NSError *error) -> void
                    let handler =
                        RcBlock::new(move |result: *mut AnyObject, _err: *mut AnyObject| {
                            if result.is_null() {
                                let _ = tx.send(None);
                                return;
                            }
                            let is_string: bool =
                                msg_send![result, isKindOfClass: objc2::class!(NSString)];
                            if !is_string {
                                let _ = tx.send(None);
                                return;
                            }
                            let utf8: *const std::ffi::c_char = msg_send![result, UTF8String];
                            if utf8.is_null() {
                                let _ = tx.send(None);
                                return;
                            }
                            let s = std::ffi::CStr::from_ptr(utf8).to_string_lossy().to_string();
                            let _ = tx.send(Some(s));
                        });

                    let _: () = msg_send![
                        wk_webview,
                        evaluateJavaScript: ns_src,
                        completionHandler: &*handler
                    ];
                }
            }
            #[cfg(target_os = "windows")]
            {
                use webview2_com::ExecuteScriptCompletedHandler;
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
                use windows::core::{HSTRING, PCWSTR};

                // The completion handler fires asynchronously on the UI thread;
                // bridge its result back over the channel like the macOS path.
                let tx_done = tx.clone();
                let controller = wv.controller();
                let script = HSTRING::from(js.as_str());
                let started = unsafe {
                    controller.CoreWebView2().and_then(|core: ICoreWebView2| {
                        core.ExecuteScript(
                            PCWSTR(script.as_ptr()),
                            &ExecuteScriptCompletedHandler::create(Box::new(
                                move |_err, result_json: String| {
                                    // ExecuteScript returns the JS value JSON-encoded:
                                    // a string arrives as "\"...\"" and JS null as
                                    // "null". Unwrap one JSON layer so we return the
                                    // same raw stored string the macOS path does
                                    // (None for null / non-string / parse failure).
                                    let value =
                                        serde_json::from_str::<Option<String>>(&result_json)
                                            .ok()
                                            .flatten();
                                    let _ = tx.send(value);
                                    Ok(())
                                },
                            )),
                        )
                    })
                };
                // If ExecuteScript couldn't even start, the handler never runs —
                // unblock the receiver now instead of waiting out the timeout.
                if started.is_err() {
                    let _ = tx_done.send(None);
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            {
                let _ = (wv, &js);
                let _ = tx.send(None);
            }
        })
        .map_err(|e| e.to_string())?;

    match rx.recv_timeout(std::time::Duration::from_secs(3)) {
        Ok(value) => Ok(value),
        Err(_) => Ok(None),
    }
}

/// Get the favicon URL for a child webview.
/// Derives from the webview's current URL origin — no JS eval needed
/// since child webviews don't have __TAURI_INTERNALS__.
#[tauri::command]
pub async fn webview_get_favicon(app: tauri::AppHandle, label: String) -> Result<String, String> {
    if let Some(webview) = app.get_webview(&label) {
        let url = webview.url().map_err(|e| format!("{}", e))?;
        if let Some(host) = url.host_str() {
            let scheme = url.scheme();
            let port = url.port().map(|p| format!(":{}", p)).unwrap_or_default();
            return Ok(format!("{}://{}{}/favicon.ico", scheme, host, port));
        }
    }
    Ok(String::new())
}

/// Find text in a child webview page.
/// Fire-and-forget: window.find() highlights matches visually.
/// Returns true always (we can't get the result back from external webviews
/// since __TAURI_INTERNALS__ is not available).
#[tauri::command]
pub async fn webview_find_in_page(
    app: tauri::AppHandle,
    label: String,
    query: String,
    forward: bool,
) -> Result<bool, String> {
    if let Some(webview) = app.get_webview(&label) {
        let escaped_query = serde_json::to_string(&query).unwrap_or_else(|_| "\"\"".to_string());
        let backward = if forward { "false" } else { "true" };
        let js = format!(
            "window.find({}, false, {}, true, false, false, false)",
            escaped_query, backward
        );
        webview
            .eval(&js)
            .map_err(|e| format!("Failed to eval: {}", e))?;
    }
    // Can't get result back from external webview, assume found
    Ok(true)
}

/// Clear find-in-page highlights in a child webview.
#[tauri::command]
pub async fn webview_clear_find(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval("window.getSelection().removeAllRanges()");
    }
    Ok(())
}

/// Set the zoom level of a child webview.
#[tauri::command]
pub async fn webview_set_zoom(
    app: tauri::AppHandle,
    label: String,
    level: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.eval(format!("document.body.style.zoom = '{}'", level));
    }
    Ok(())
}

// Context menu: using native WKWebView / WebView2 built-in context menu.
// No custom Rust handler needed — the native menu provides Copy/Paste/Look Up/etc.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teamclu_identity_script_is_refreshable() {
        let script = build_teamclu_identity_script("device-1", "Alice");

        assert!(script.contains("__TEAMCLU_SET_IDENTITY__"));
        assert!(script.contains("get deviceToken()"));
        assert!(script.contains("configurable: true"));
        assert!(script.contains("\"device-1\""));
        assert!(script.contains("\"Alice\""));
        // deviceToken is always null now (master-data JWT removed).
        assert!(script.contains("deviceToken: null"));
    }

    #[test]
    fn teamclu_identity_script_escapes_values() {
        let script = build_teamclu_identity_script("device\"quoted", "name\nline");

        assert!(script.contains("device\\\"quoted"));
        assert!(script.contains("name\\nline"));
        assert!(script.contains("deviceToken: null"));
    }

    #[test]
    fn external_webview_init_script_suppresses_notification_readonly_rejection() {
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("unhandledrejection"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("Readonly property"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("evt.preventDefault()"));
    }

    #[test]
    fn external_webview_init_script_wraps_notification_permission_setter() {
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("__TEAMCLU_SAFE_NOTIFICATION__"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("function SafeNotification"));
        assert!(EXTERNAL_WEBVIEW_INIT_SCRIPT.contains("set: function(next)"));
    }

    #[test]
    fn read_local_storage_js_reads_the_given_key() {
        let js = build_read_local_storage_js("sb-test-supa-auth-token");
        assert!(js.contains("localStorage.getItem(\"sb-test-supa-auth-token\")"));
    }

    #[test]
    fn read_local_storage_js_escapes_the_key() {
        let js = build_read_local_storage_js("a\"b");
        assert!(js.contains("\"a\\\"b\""));
    }

    #[test]
    fn clear_session_script_removes_key_once_via_session_flag() {
        let js = build_clear_session_script("sb-test-supa-auth-token");
        // Guarded by a one-shot sessionStorage flag so the post-login session
        // isn't wiped on a redirect.
        assert!(js.contains("__teamclu_websso_cleared"));
        assert!(js.contains("sessionStorage.getItem"));
        assert!(js.contains("localStorage.removeItem(\"sb-test-supa-auth-token\")"));
    }

    #[test]
    fn ensure_http_host_resolvable_accepts_ip_literals() {
        let url: tauri::Url = "http://127.0.0.1:8080/path".parse().expect("url");
        assert!(ensure_http_host_resolvable(&url).is_ok());
    }

    #[test]
    fn ensure_http_host_resolvable_skips_non_http_schemes() {
        let url: tauri::Url = "data:text/plain,hi".parse().expect("url");
        assert!(ensure_http_host_resolvable(&url).is_ok());
    }

    #[test]
    fn ensure_http_host_resolvable_rejects_unresolvable_host() {
        // `.invalid` is reserved by RFC 2606 and must not resolve on the public DNS.
        let url: tauri::Url = "https://no-such-host-teamclu-617.invalid/path"
            .parse()
            .expect("url");
        let err = ensure_http_host_resolvable(&url).expect_err("unresolvable host");
        assert!(
            err.contains("no-such-host-teamclu-617.invalid"),
            "error should name the host: {err}"
        );
    }
}

#[cfg(test)]
mod identity_origin_tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).unwrap()
    }

    #[test]
    fn admin_console_vetted_https_origin_is_trusted() {
        assert_eq!(
            identity_injection_origin(&url("https://admin.example.com/login?x=1"), true),
            Some("https://admin.example.com".to_string())
        );
    }

    #[test]
    fn unvetted_third_party_gets_nothing() {
        assert_eq!(
            identity_injection_origin(&url("https://partner.example.org/"), false),
            None
        );
    }

    #[test]
    fn vetted_but_plaintext_http_gets_nothing() {
        assert_eq!(
            identity_injection_origin(&url("http://admin.example.com/login"), true),
            None
        );
    }

    #[test]
    fn loopback_is_trusted_even_over_http() {
        assert_eq!(
            identity_injection_origin(&url("http://localhost:5173/"), false),
            Some("http://localhost:5173".to_string())
        );
    }

    #[test]
    fn origin_key_keeps_scheme_host_and_port_only() {
        assert_eq!(
            origin_key(&url("https://a.b:8443/p?q#f")),
            "https://a.b:8443"
        );
        assert_eq!(origin_key(&url("https://a.b/p")), "https://a.b");
    }
}
