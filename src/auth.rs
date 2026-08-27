use std::time::{SystemTime, UNIX_EPOCH};

use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier, password_hash::SaltString};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use uuid::Uuid;

use crate::config::Config;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Unique session identifier. Signaling uses this as the peer id.
    pub sub: String,
    /// Configured account name. Used for per-account resource limits.
    pub user: String,
    pub name: String,
    pub role: String,
    pub iat: usize,
    pub exp: usize,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SessionResponse {
    pub token: String,
    #[serde(rename = "clientId")]
    pub client_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: usize,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub role: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: &'static str,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("authentication failed")]
    Unauthorized,
    #[error("room is full")]
    RoomFull,
    #[error("service capacity reached")]
    Capacity,
    #[error("too many requests")]
    RateLimited,
    #[error("internal server error")]
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, error) = match self {
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            Self::RoomFull => (StatusCode::CONFLICT, "room_full"),
            Self::Capacity => (StatusCode::SERVICE_UNAVAILABLE, "capacity_reached"),
            Self::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rate_limited"),
            Self::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
        };
        let message = self.to_string();
        (status, Json(ErrorBody { error, message })).into_response()
    }
}

pub fn login(config: &Config, request: &LoginRequest) -> Result<SessionResponse, ApiError> {
    if request.username.len() > 40 || request.password.len() > 256 {
        return Err(ApiError::Unauthorized);
    }

    // Always perform one Argon2 verification, even for an unknown username.
    // This avoids a cheap username-enumeration timing oracle.
    let user = config.auth_users.iter().find(|user| user.username == request.username);
    let password_hash = user
        .map(|user| user.password_hash.as_str())
        .unwrap_or_else(|| config.auth_users[0].password_hash.as_str());
    let parsed_hash = PasswordHash::new(password_hash).map_err(|_| ApiError::Internal)?;
    let password_ok = Argon2::default()
        .verify_password(request.password.as_bytes(), &parsed_hash)
        .is_ok();
    let Some(user) = user else {
        return Err(ApiError::Unauthorized);
    };
    if !password_ok {
        return Err(ApiError::Unauthorized);
    }

    let now = unix_time() as usize;
    let client_id = Uuid::new_v4().to_string();
    let expires_at = now + config.session_ttl_secs as usize;
    let claims = Claims {
        sub: client_id.clone(),
        user: user.username.clone(),
        name: user.display_name.clone(),
        role: user.role.clone(),
        iat: now,
        exp: expires_at,
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
    )
    .map_err(|_| ApiError::Internal)?;
    Ok(SessionResponse {
        token,
        client_id,
        expires_at,
        display_name: user.display_name.clone(),
        role: user.role.clone(),
    })
}

pub fn hash_password(password: &str) -> Result<String, String> {
    if password.chars().count() < 10 || password.len() > 256 {
        return Err("password must contain 10-256 characters".into());
    }
    let salt = SaltString::encode_b64(Uuid::new_v4().as_bytes()).map_err(|error| error.to_string())?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| error.to_string())
}

pub fn verify_token(config: &Config, token: &str) -> Result<Claims, ApiError> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.jwt_secret.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map(|data| data.claims)
    .map_err(|_| ApiError::Unauthorized)
}

/// Derive a stable, high-entropy TURN credential for one configured account.
///
/// v1.0 deliberately uses the embedded TURN server's static credential table
/// instead of TURN REST's timestamp username mode: turn-server 4.1.4 does not
/// validate REST timestamps. Only configured application accounts are inserted
/// into the TURN credential table, and rotating TURN_SECRET invalidates all of
/// them immediately after a service restart.
pub fn turn_credentials(config: &Config, account: &str) -> Option<(String, String)> {
    let secret = config.turn_secret.as_ref()?;
    let username = format!("remote-caller:{account}");
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).ok()?;
    mac.update(b"remote-caller-turn-v1\0");
    mac.update(account.as_bytes());
    let credential = STANDARD.encode(mac.finalize().into_bytes());
    Some((username, credential))
}

pub fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
