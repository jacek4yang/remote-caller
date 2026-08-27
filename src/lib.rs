pub mod auth;
pub mod config;
#[cfg(target_os = "linux")]
pub mod embedded_turn;
pub mod signal;
pub mod state;

use std::sync::atomic::Ordering;

use auth::{ApiError, LoginRequest, SessionResponse};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use state::{AppState, JoinRoomError};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Deserialize)]
struct WsQuery {
    ticket: String,
}

#[derive(Debug, Deserialize)]
struct WsTicketRequest {
    room: String,
}

#[derive(Debug, Serialize)]
struct WsTicketResponse {
    ticket: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

#[derive(Serialize)]
struct IceServer {
    urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential: Option<String>,
}

pub fn app(state: AppState) -> Router {
    let mut router = Router::new()
        .route("/api/login", post(login))
        .route("/api/config", get(client_config))
        .route("/api/ws-ticket", post(ws_ticket))
        .route("/ws", get(websocket))
        .route("/health/live", get(|| async { StatusCode::NO_CONTENT }))
        .route("/health/ready", get(|| async { Json(json!({"status":"ready"})) }))
        .route("/metrics", get(metrics));

    if state.config.serve_static {
        let static_dir = state.config.static_dir.clone();
        let static_service = ServeDir::new(&static_dir)
            .append_index_html_on_directories(true)
            .not_found_service(ServeFile::new(format!("{static_dir}/index.html")));
        router = router.fallback_service(static_service);
    }

    router
        // No application endpoint needs a large request body. This is a second
        // line of defense behind Nginx's client_max_body_size.
        .layer(DefaultBodyLimit::max(8 * 1024))
        .layer(middleware::from_fn(security_headers))
        .layer(CompressionLayer::new())
        .layer(
            TraceLayer::new_for_http().make_span_with(|request: &axum::extract::Request| {
                // WebSocket URLs contain only a short-lived one-time ticket.
                // Still log only the path so credentials never enter logs.
                tracing::info_span!(
                    "http_request",
                    method = %request.method(),
                    path = %request.uri().path()
                )
            }),
        )
        .with_state(state)
}

async fn login(
    State(state): State<AppState>,
    Json(request): Json<LoginRequest>,
) -> Result<Json<SessionResponse>, ApiError> {
    // Bound expensive Argon2 work globally. A botnet cannot create an
    // unbounded spawn_blocking backlog even if Nginx per-IP limits are bypassed.
    let permit = state.login_slots.clone().try_acquire_owned().map_err(|_| {
        state.metrics.rejected_logins.fetch_add(1, Ordering::Relaxed);
        ApiError::RateLimited
    })?;
    let config = state.config.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        auth::login(&config, &request)
    })
    .await
    .map_err(|_| ApiError::Internal)?;
    if result.is_err() {
        state.metrics.rejected_logins.fetch_add(1, Ordering::Relaxed);
    }
    result.map(Json)
}

async fn client_config(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<serde_json::Value>, ApiError> {
    let token = bearer_token(&headers)?;
    let claims = auth::verify_token(&state.config, token)?;
    let mut servers = vec![IceServer {
        urls: vec![state.config.public_stun_url.clone()],
        username: None,
        credential: None,
    }];
    if let Some((username, credential)) = auth::turn_credentials(&state.config, &claims.user) {
        servers.push(IceServer {
            urls: state.config.turn_urls.clone(),
            username: Some(username),
            credential: Some(credential),
        });
    }
    Ok(Json(json!({ "iceServers": servers })))
}

async fn ws_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<WsTicketRequest>,
) -> Result<Json<WsTicketResponse>, ApiError> {
    validate_room(&request.room)?;
    let claims = auth::verify_token(&state.config, bearer_token(&headers)?)?;
    let (ticket, expires_at) = state.issue_ws_ticket(claims, request.room).ok_or(ApiError::Capacity)?;
    Ok(Json(WsTicketResponse { ticket, expires_at }))
}

async fn websocket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
) -> Result<Response, ApiError> {
    if query.ticket.len() > 80 {
        return Err(ApiError::Unauthorized);
    }
    let (claims, room_id) = state.consume_ws_ticket(&query.ticket).ok_or(ApiError::Unauthorized)?;

    let ws_permit = state.try_acquire_ws_slot().ok_or_else(|| {
        state.metrics.rejected_connections.fetch_add(1, Ordering::Relaxed);
        ApiError::Capacity
    })?;
    let user_lease = state.try_reserve_user_connection(&claims.user).ok_or_else(|| {
        state.metrics.rejected_connections.fetch_add(1, Ordering::Relaxed);
        ApiError::Capacity
    })?;
    let room_lease = state.try_join_room(&room_id).map_err(|error| {
        state.metrics.rejected_connections.fetch_add(1, Ordering::Relaxed);
        match error {
            JoinRoomError::Full => ApiError::RoomFull,
            JoinRoomError::Capacity => ApiError::Capacity,
        }
    })?;

    Ok(ws
        .max_message_size(65_536)
        .max_frame_size(65_536)
        .on_upgrade(move |socket| async move {
            let _ws_permit = ws_permit;
            let _user_lease = user_lease;
            signal::handle_socket(socket, claims, state, room_lease).await;
        }))
}

async fn metrics(State(state): State<AppState>) -> impl IntoResponse {
    let metrics = &state.metrics;
    let body = format!(
        "# TYPE remote_caller_active_connections gauge\nremote_caller_active_connections {}\n\
         # TYPE remote_caller_active_rooms gauge\nremote_caller_active_rooms {}\n\
         # TYPE remote_caller_total_connections counter\nremote_caller_total_connections {}\n\
         # TYPE remote_caller_signaling_messages counter\nremote_caller_signaling_messages {}\n\
         # TYPE remote_caller_rejected_connections counter\nremote_caller_rejected_connections {}\n\
         # TYPE remote_caller_rejected_logins counter\nremote_caller_rejected_logins {}\n\
         # TYPE remote_caller_issued_ws_tickets counter\nremote_caller_issued_ws_tickets {}\n",
        metrics.active_connections.load(Ordering::Relaxed),
        state.rooms.len(),
        metrics.total_connections.load(Ordering::Relaxed),
        metrics.signaling_messages.load(Ordering::Relaxed),
        metrics.rejected_connections.load(Ordering::Relaxed),
        metrics.rejected_logins.load(Ordering::Relaxed),
        metrics.issued_ws_tickets.load(Ordering::Relaxed),
    );
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body)
}

async fn security_headers(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(self), microphone=(self), geolocation=()"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    ));
    response
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty() && value.len() <= 4096)
        .ok_or(ApiError::Unauthorized)
}

fn validate_room(room: &str) -> Result<(), ApiError> {
    if (6..=64).contains(&room.len())
        && room
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Ok(())
    } else {
        Err(ApiError::BadRequest("room must be 6-64 URL-safe characters".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    fn config_with_user() -> Config {
        let mut config = Config::test();
        config.auth_users.push(crate::config::AuthUser {
            username: "alice".into(),
            display_name: "Alice".into(),
            password_hash: auth::hash_password("correct horse battery staple").unwrap(),
            role: "admin".into(),
        });
        config
    }

    #[test]
    fn validates_room_ids() {
        assert!(validate_room("team-123").is_ok());
        assert!(validate_room("bad room").is_err());
        assert!(validate_room("tiny").is_err());
    }

    #[test]
    fn session_round_trip_and_turn_credentials() {
        let config = config_with_user();
        let session = auth::login(
            &config,
            &LoginRequest {
                username: "alice".into(),
                password: "correct horse battery staple".into(),
            },
        )
        .unwrap();
        let claims = auth::verify_token(&config, &session.token).unwrap();
        assert_eq!(claims.name, "Alice");
        assert_eq!(claims.user, "alice");
        let first = auth::turn_credentials(&config, &claims.user).unwrap();
        let second = auth::turn_credentials(&config, &claims.user).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.0, "remote-caller:alice");
        assert!(!first.1.is_empty());
    }

    #[test]
    fn unknown_username_is_rejected_after_hash_work() {
        let config = config_with_user();
        let result = auth::login(
            &config,
            &LoginRequest {
                username: "missing".into(),
                password: "correct horse battery staple".into(),
            },
        );
        assert!(matches!(result, Err(ApiError::Unauthorized)));
    }

    #[tokio::test]
    async fn ws_ticket_is_single_use() {
        let state = AppState::new(config_with_user());
        let claims = crate::auth::Claims {
            sub: "session".into(),
            user: "alice".into(),
            name: "Alice".into(),
            role: "admin".into(),
            iat: 1,
            exp: usize::MAX,
        };
        let (ticket, _) = state.issue_ws_ticket(claims, "room-123".into()).unwrap();
        assert!(state.consume_ws_ticket(&ticket).is_some());
        assert!(state.consume_ws_ticket(&ticket).is_none());
    }

    #[test]
    fn room_capacity_is_bounded() {
        let mut config = config_with_user();
        config.max_rooms = 1;
        let state = AppState::new(config);
        let first = state.try_join_room("room-001").unwrap();
        assert!(matches!(state.try_join_room("room-002"), Err(JoinRoomError::Capacity)));
        drop(first);
        assert!(state.try_join_room("room-002").is_ok());
    }
}
