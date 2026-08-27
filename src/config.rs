use std::{
    env,
    net::{IpAddr, SocketAddr},
};

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    #[serde(default = "default_user_role")]
    pub role: String,
}

fn default_user_role() -> String {
    "user".into()
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_addr: SocketAddr,
    pub jwt_secret: String,
    pub session_ttl_secs: u64,
    pub auth_max_concurrent_hashes: usize,
    pub max_ws_connections: usize,
    pub max_ws_per_user: usize,
    pub max_rooms: usize,
    pub ws_ticket_ttl_secs: u64,
    pub max_pending_ws_tickets: usize,
    pub turn_urls: Vec<String>,
    pub turn_secret: Option<String>,
    pub public_stun_url: String,
    pub static_dir: String,
    pub serve_static: bool,
    pub auth_users: Vec<AuthUser>,
    pub embedded_turn: bool,
    pub turn_public_ip: Option<IpAddr>,
    pub turn_bind_ip: IpAddr,
    pub turn_realm: String,
    pub turn_port: u16,
    pub turn_tls_port: u16,
    pub turn_relay_min_port: u16,
    pub turn_relay_max_port: u16,
    pub turn_tls_cert: Option<String>,
    pub turn_tls_key: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        // Production should expose only Nginx publicly. Safe-by-default bind.
        let bind_addr = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8080".into())
            .parse()
            .map_err(|e| format!("invalid BIND_ADDR: {e}"))?;
        let jwt_secret = env::var("JWT_SECRET").map_err(|_| "JWT_SECRET is required".to_string())?;
        if jwt_secret.len() < 32 {
            return Err("JWT_SECRET must contain at least 32 characters".into());
        }

        let admin_password_hash = env::var("ADMIN_PASSWORD_HASH").map_err(|_| {
            "ADMIN_PASSWORD_HASH is required; run `remote-caller hash-password` to create it".to_string()
        })?;
        let mut auth_users = vec![AuthUser {
            username: env::var("ADMIN_USERNAME").unwrap_or_else(|_| "admin".into()),
            display_name: env::var("ADMIN_DISPLAY_NAME").unwrap_or_else(|_| "Admin".into()),
            password_hash: admin_password_hash,
            role: "admin".into(),
        }];
        let extra_users = env::var("USERS_JSON").unwrap_or_else(|_| "[]".into());
        auth_users.extend(
            serde_json::from_str::<Vec<AuthUser>>(&extra_users)
                .map_err(|error| format!("invalid USERS_JSON: {error}"))?,
        );
        validate_users(&auth_users)?;
        if auth_users.len() > 8 {
            return Err("this personal deployment build supports at most 8 configured users".into());
        }

        let embedded_turn = read_bool("EMBEDDED_TURN", cfg!(target_os = "linux"))?;
        if embedded_turn && !cfg!(target_os = "linux") {
            return Err("EMBEDDED_TURN is supported only by the Linux binary".into());
        }
        let turn_secret = env::var("TURN_SECRET").ok().filter(|secret| !secret.is_empty());
        if embedded_turn && turn_secret.as_ref().is_none_or(|secret| secret.len() < 32) {
            return Err("TURN_SECRET must contain at least 32 characters when EMBEDDED_TURN=true".into());
        }
        let turn_public_ip = env::var("TURN_PUBLIC_IP")
            .ok()
            .map(|value| {
                value
                    .parse()
                    .map_err(|error| format!("invalid TURN_PUBLIC_IP: {error}"))
            })
            .transpose()?;
        if embedded_turn && turn_public_ip.is_none() {
            return Err("TURN_PUBLIC_IP is required when EMBEDDED_TURN=true".into());
        }
        let turn_realm = env::var("TURN_REALM").unwrap_or_else(|_| "localhost".into());
        let turn_tls_cert = env::var("TURN_TLS_CERT").ok().filter(|value| !value.is_empty());
        let turn_tls_key = env::var("TURN_TLS_KEY").ok().filter(|value| !value.is_empty());
        if turn_tls_cert.is_some() != turn_tls_key.is_some() {
            return Err("TURN_TLS_CERT and TURN_TLS_KEY must be configured together".into());
        }
        let turn_port = read_u16("TURN_PORT", 3478)?;
        let turn_tls_port = read_u16("TURN_TLS_PORT", 5349)?;
        let turn_relay_min_port = read_u16("TURN_RELAY_MIN_PORT", 49160)?;
        let turn_relay_max_port = read_u16("TURN_RELAY_MAX_PORT", 49175)?;
        if turn_relay_min_port < 49_152 || turn_relay_min_port > turn_relay_max_port {
            return Err("TURN relay port range must be ordered and start at or above 49152".into());
        }
        if u32::from(turn_relay_max_port) - u32::from(turn_relay_min_port) + 1 > 128 {
            return Err("TURN relay port range must contain at most 128 ports for this personal build".into());
        }
        let default_turn_urls = || {
            let mut urls = vec![
                format!("turn:{turn_realm}:{turn_port}?transport=udp"),
                format!("turn:{turn_realm}:{turn_port}?transport=tcp"),
            ];
            if turn_tls_cert.is_some() {
                urls.push(format!("turns:{turn_realm}:{turn_tls_port}?transport=tcp"));
            }
            urls.join(",")
        };

        let max_ws_connections = read_usize("MAX_WS_CONNECTIONS", 16)?;
        let max_ws_per_user = read_usize("MAX_WS_PER_USER", 3)?;
        let max_rooms = read_usize("MAX_ROOMS", 8)?;
        let auth_max_concurrent_hashes = read_usize("AUTH_MAX_CONCURRENT_HASHES", 2)?;
        let max_pending_ws_tickets = read_usize("MAX_PENDING_WS_TICKETS", 32)?;
        if max_ws_connections == 0
            || max_ws_per_user == 0
            || max_rooms == 0
            || auth_max_concurrent_hashes == 0
            || max_pending_ws_tickets == 0
        {
            return Err("resource limits must be greater than zero".into());
        }
        let session_ttl_secs = read_u64("SESSION_TTL_SECS", 604_800)?;
        if !(3_600..=2_592_000).contains(&session_ttl_secs) {
            return Err("SESSION_TTL_SECS must be between 3600 and 2592000 seconds".into());
        }
        let ws_ticket_ttl_secs = read_u64("WS_TICKET_TTL_SECS", 30)?;
        if !(10..=300).contains(&ws_ticket_ttl_secs) {
            return Err("WS_TICKET_TTL_SECS must be between 10 and 300 seconds".into());
        }

        Ok(Self {
            bind_addr,
            jwt_secret,
            // The token stays only in memory in the browser. A longer session
            // allows multi-hour/day private calls to recover signaling without
            // storing the password or forcing a new login.
            session_ttl_secs,
            auth_max_concurrent_hashes,
            max_ws_connections,
            max_ws_per_user,
            max_rooms,
            ws_ticket_ttl_secs,
            max_pending_ws_tickets,
            turn_urls: env::var("TURN_URLS")
                .unwrap_or_else(|_| default_turn_urls())
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect(),
            turn_secret,
            public_stun_url: env::var("STUN_URL").unwrap_or_else(|_| "stun:stun.l.google.com:19302".into()),
            static_dir: env::var("STATIC_DIR").unwrap_or_else(|_| "web".into()),
            serve_static: read_bool("SERVE_STATIC", true)?,
            auth_users,
            embedded_turn,
            turn_public_ip,
            turn_bind_ip: env::var("TURN_BIND_IP")
                .unwrap_or_else(|_| "0.0.0.0".into())
                .parse()
                .map_err(|error| format!("invalid TURN_BIND_IP: {error}"))?,
            turn_realm,
            turn_port,
            turn_tls_port,
            turn_relay_min_port,
            turn_relay_max_port,
            turn_tls_cert,
            turn_tls_key,
        })
    }

    #[cfg(test)]
    pub fn test() -> Self {
        Self {
            bind_addr: "127.0.0.1:0".parse().unwrap(),
            jwt_secret: "test-secret-that-is-definitely-long-enough".into(),
            session_ttl_secs: 3_600,
            auth_max_concurrent_hashes: 2,
            max_ws_connections: 16,
            max_ws_per_user: 3,
            max_rooms: 8,
            ws_ticket_ttl_secs: 30,
            max_pending_ws_tickets: 32,
            turn_urls: vec!["turn:turn.example.com:3478".into()],
            turn_secret: Some("turn-test-secret-that-is-long-enough".into()),
            public_stun_url: "stun:stun.example.com:3478".into(),
            static_dir: "web".into(),
            serve_static: true,
            auth_users: vec![],
            embedded_turn: false,
            turn_public_ip: None,
            turn_bind_ip: "0.0.0.0".parse().unwrap(),
            turn_realm: "turn.example.com".into(),
            turn_port: 3478,
            turn_tls_port: 5349,
            turn_relay_min_port: 49160,
            turn_relay_max_port: 49175,
            turn_tls_cert: None,
            turn_tls_key: None,
        }
    }
}

fn validate_users(users: &[AuthUser]) -> Result<(), String> {
    for (index, user) in users.iter().enumerate() {
        if user.username.is_empty()
            || user.username.len() > 40
            || !user
                .username
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(format!("invalid username at auth user index {index}"));
        }
        if user.display_name.trim().is_empty() || user.display_name.chars().count() > 40 {
            return Err(format!("invalid displayName at auth user index {index}"));
        }
        if !user.password_hash.starts_with("$argon2id$") {
            return Err(format!(
                "passwordHash at auth user index {index} must be an Argon2id PHC string"
            ));
        }
        if !matches!(user.role.as_str(), "admin" | "user") {
            return Err(format!("invalid role at auth user index {index}"));
        }
        if users[..index].iter().any(|existing| existing.username == user.username) {
            return Err(format!("duplicate username: {}", user.username));
        }
    }
    Ok(())
}

fn read_bool(key: &str, default: bool) -> Result<bool, String> {
    match env::var(key) {
        Err(_) => Ok(default),
        Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes") => Ok(true),
        Ok(value) if matches!(value.to_ascii_lowercase().as_str(), "0" | "false" | "no") => Ok(false),
        Ok(_) => Err(format!("invalid {key}: expected true or false")),
    }
}

fn read_u64(key: &str, default: u64) -> Result<u64, String> {
    env::var(key).map_or(Ok(default), |value| {
        value.parse().map_err(|e| format!("invalid {key}: {e}"))
    })
}

fn read_u16(key: &str, default: u16) -> Result<u16, String> {
    env::var(key).map_or(Ok(default), |value| {
        value.parse().map_err(|error| format!("invalid {key}: {error}"))
    })
}

fn read_usize(key: &str, default: usize) -> Result<usize, String> {
    env::var(key).map_or(Ok(default), |value| {
        value.parse().map_err(|error| format!("invalid {key}: {error}"))
    })
}
