pub mod auth;
pub mod config;
#[cfg(target_os = "linux")]
pub mod embedded_turn;
pub mod signal;
pub mod state;

use std::sync::atomic::Ordering;

use auth::{ApiError, Claims, LoginRequest, SessionResponse};
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
use uuid::Uuid;

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
        .route("/health/ready", get(readiness))
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
    if !state.is_accepting() {
        return Err(ApiError::Capacity);
    }
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
    if !state.is_accepting() {
        return Err(ApiError::Capacity);
    }
    let claims = authorized_claims(&state, &headers)?;
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
    if !state.is_accepting() {
        return Err(ApiError::Capacity);
    }
    validate_room(&request.room)?;
    let claims = authorized_claims(&state, &headers)?;
    let (ticket, expires_at) = state.issue_ws_ticket(claims, request.room).ok_or(ApiError::Capacity)?;
    Ok(Json(WsTicketResponse { ticket, expires_at }))
}

async fn websocket(
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !state.is_accepting() {
        return Err(ApiError::Capacity);
    }
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
    // The JWT subject is stable across signaling reconnects. Use a fresh
    // internal lease id so the cancelled socket cannot remove its replacement.
    let room_connection_id = Uuid::new_v4().to_string();
    let room_lease = state
        .try_join_room(&room_id, &claims.user, &room_connection_id)
        .map_err(|error| {
            state.metrics.rejected_connections.fetch_add(1, Ordering::Relaxed);
            match error {
                JoinRoomError::Full => ApiError::RoomFull,
                JoinRoomError::Capacity => ApiError::Capacity,
            }
        })?;

    Ok(ws
        .max_message_size(signal::MAX_SIGNAL_MESSAGE_SIZE)
        .max_frame_size(signal::MAX_SIGNAL_MESSAGE_SIZE)
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
         # TYPE remote_caller_rejected_signaling_messages counter\nremote_caller_rejected_signaling_messages {}\n\
         # TYPE remote_caller_issued_ws_tickets counter\nremote_caller_issued_ws_tickets {}\n",
        metrics.active_connections.load(Ordering::Relaxed),
        state.rooms.len(),
        metrics.total_connections.load(Ordering::Relaxed),
        metrics.signaling_messages.load(Ordering::Relaxed),
        metrics.rejected_connections.load(Ordering::Relaxed),
        metrics.rejected_logins.load(Ordering::Relaxed),
        metrics.rejected_signaling_messages.load(Ordering::Relaxed),
        metrics.issued_ws_tickets.load(Ordering::Relaxed),
    );
    ([(header::CONTENT_TYPE, "text/plain; version=0.0.4")], body)
}

async fn security_headers(request: axum::extract::Request, next: Next) -> Response {
    let no_store = request.uri().path().starts_with("/api/")
        || request.uri().path().starts_with("/health/")
        || request.uri().path() == "/metrics";
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
    if no_store {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    }
    response
}

async fn readiness(State(state): State<AppState>) -> Response {
    if state.is_ready() {
        (StatusCode::OK, Json(json!({"status":"ready"}))).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"status":"not_ready"}))).into_response()
    }
}

fn authorized_claims(state: &AppState, headers: &HeaderMap) -> Result<Claims, ApiError> {
    let claims = auth::verify_token(&state.config, bearer_token(headers)?)?;
    if state
        .config
        .auth_users
        .iter()
        .any(|user| user.username == claims.user && user.display_name == claims.name && user.role == claims.role)
    {
        Ok(claims)
    } else {
        Err(ApiError::Unauthorized)
    }
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
    use std::sync::OnceLock;

    use super::*;
    use crate::{
        auth::unix_time,
        config::{AuthUser, Config},
    };
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tower::ServiceExt;

    const PASSWORD: &str = "correct horse battery staple";

    fn password_hash() -> String {
        static HASH: OnceLock<String> = OnceLock::new();
        HASH.get_or_init(|| auth::hash_password(PASSWORD).expect("test password must hash"))
            .clone()
    }

    fn config_with_user() -> Config {
        let mut config = Config::test();
        config.auth_users.push(AuthUser {
            username: "alice".into(),
            display_name: "Alice".into(),
            password_hash: password_hash(),
            role: "user".into(),
        });
        config
    }

    fn test_claims(user: &str, sub: &str) -> Claims {
        let now = unix_time();
        Claims {
            sub: sub.into(),
            user: user.into(),
            name: if user == "alice" { "Alice" } else { "Bob" }.into(),
            role: "user".into(),
            iss: "remote-caller".into(),
            aud: "remote-caller-web".into(),
            iat: now,
            exp: now + 3_600,
        }
    }

    fn login_request(username: &str, password: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri("/api/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({"username": username, "password": password}).to_string(),
            ))
            .expect("test request must build")
    }

    fn encode_claims(config: &Config, claims: &Claims, algorithm: Algorithm) -> String {
        encode(
            &Header::new(algorithm),
            claims,
            &EncodingKey::from_secret(config.jwt_secret.as_bytes()),
        )
        .expect("test token must encode")
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
                password: PASSWORD.into(),
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
    fn wrong_password_and_unknown_username_are_rejected() {
        let config = config_with_user();
        let wrong = auth::login(
            &config,
            &LoginRequest {
                username: "alice".into(),
                password: "wrong password".into(),
            },
        );
        let missing = auth::login(
            &config,
            &LoginRequest {
                username: "missing".into(),
                password: PASSWORD.into(),
            },
        );
        assert!(matches!(wrong, Err(ApiError::Unauthorized)));
        assert!(matches!(missing, Err(ApiError::Unauthorized)));
    }

    #[test]
    fn oversized_login_fields_are_rejected() {
        let config = config_with_user();
        let result = auth::login(
            &config,
            &LoginRequest {
                username: "a".repeat(41),
                password: "p".repeat(257),
            },
        );
        assert!(matches!(result, Err(ApiError::Unauthorized)));
    }

    #[test]
    fn jwt_rejects_expiry_malformed_signature_and_algorithm() {
        let config = config_with_user();
        let valid = encode_claims(&config, &test_claims("alice", "session"), Algorithm::HS256);
        assert!(auth::verify_token(&config, &valid).is_ok());
        assert!(matches!(
            auth::verify_token(&config, "not-a-jwt"),
            Err(ApiError::Unauthorized)
        ));

        let mut wrong_secret = config.clone();
        wrong_secret.jwt_secret = "different-test-secret-with-enough-entropy".into();
        assert!(matches!(
            auth::verify_token(&wrong_secret, &valid),
            Err(ApiError::Unauthorized)
        ));

        let now = unix_time();
        let mut expired = test_claims("alice", "expired");
        expired.iat = now.saturating_sub(600);
        expired.exp = now.saturating_sub(120);
        let expired = encode_claims(&config, &expired, Algorithm::HS256);
        assert!(matches!(
            auth::verify_token(&config, &expired),
            Err(ApiError::Unauthorized)
        ));

        let wrong_algorithm = encode_claims(&config, &test_claims("alice", "algorithm"), Algorithm::HS384);
        assert!(matches!(
            auth::verify_token(&config, &wrong_algorithm),
            Err(ApiError::Unauthorized)
        ));
    }

    #[test]
    fn turn_credentials_rotate_with_secret() {
        let config = config_with_user();
        let original = auth::turn_credentials(&config, "alice").expect("TURN is configured");
        let mut rotated = config;
        rotated.turn_secret = Some("rotated-turn-secret-with-enough-entropy".into());
        let rotated = auth::turn_credentials(&rotated, "alice").expect("TURN is configured");
        assert_eq!(original.0, rotated.0);
        assert_ne!(original.1, rotated.1);
    }

    #[tokio::test]
    async fn login_http_validation_and_argon2_budget_are_enforced() {
        let state = AppState::new(config_with_user());
        let response = app(state.clone())
            .oneshot(login_request("alice", PASSWORD))
            .await
            .expect("request must complete");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL),
            Some(&HeaderValue::from_static("no-store"))
        );

        let response = app(state.clone())
            .oneshot(login_request("alice", "wrong password"))
            .await
            .expect("request must complete");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let malformed = Request::builder()
            .method("POST")
            .uri("/api/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{"))
            .expect("test request must build");
        let response = app(state.clone())
            .oneshot(malformed)
            .await
            .expect("request must complete");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let oversized = Request::builder()
            .method("POST")
            .uri("/api/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("x".repeat(8 * 1024 + 1)))
            .expect("test request must build");
        let response = app(state.clone())
            .oneshot(oversized)
            .await
            .expect("request must complete");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let permit = state
            .login_slots
            .clone()
            .acquire_many_owned(state.config.auth_max_concurrent_hashes as u32)
            .await
            .expect("test must acquire login budget");
        let response = app(state)
            .oneshot(login_request("alice", PASSWORD))
            .await
            .expect("request must complete");
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        drop(permit);
    }

    #[tokio::test]
    async fn ws_ticket_is_single_use_expiring_and_bounded() {
        let mut config = config_with_user();
        config.max_pending_ws_tickets = 1;
        let state = AppState::new(config);
        let claims = test_claims("alice", "session");
        let (ticket, _) = state.issue_ws_ticket(claims, "room-123".into()).unwrap();
        assert!(
            state
                .issue_ws_ticket(test_claims("alice", "second"), "room-123".into())
                .is_none()
        );
        assert!(state.consume_ws_ticket(&ticket).is_some());
        assert!(state.consume_ws_ticket(&ticket).is_none());
        assert!(
            state
                .issue_ws_ticket(test_claims("alice", "second"), "room-123".into())
                .is_some()
        );

        let mut config = config_with_user();
        config.ws_ticket_ttl_secs = 0;
        let expiring = AppState::new(config);
        let (ticket, _) = expiring
            .issue_ws_ticket(test_claims("alice", "expired"), "room-123".into())
            .unwrap();
        assert!(expiring.consume_ws_ticket(&ticket).is_none());
    }

    #[tokio::test]
    async fn room_membership_cleanup_reconnect_and_capacity_are_correct() {
        let mut config = config_with_user();
        config.max_rooms = 1;
        let state = AppState::new(config);
        let mut first = state.try_join_room("room-001", "alice", "session-a").unwrap();
        let cancelled = first.take_cancelled();
        let replacement = state.try_join_room("room-001", "alice", "session-a2").unwrap();
        assert!(cancelled.await.is_ok());
        assert!(!first.is_current());
        assert!(replacement.is_current());
        assert_eq!(replacement.room().member_count(), 1);

        let second = state.try_join_room("room-001", "bob", "session-b").unwrap();
        assert_eq!(second.room().member_count(), 2);
        assert!(matches!(
            state.try_join_room("room-001", "carol", "session-c"),
            Err(JoinRoomError::Full)
        ));
        assert!(matches!(
            state.try_join_room("room-002", "carol", "session-c"),
            Err(JoinRoomError::Capacity)
        ));

        drop(first);
        drop(second);
        assert_eq!(replacement.room().member_count(), 1);
        drop(replacement);
        assert!(state.rooms.is_empty());
        assert!(state.try_join_room("room-002", "alice", "session-new").is_ok());
    }

    #[tokio::test]
    async fn concurrent_third_distinct_room_member_is_rejected() {
        let state = AppState::new(config_with_user());
        let first_state = state.clone();
        let second_state = state.clone();
        let third_state = state.clone();
        let first = tokio::spawn(async move { first_state.try_join_room("race-room", "alice", "session-a") });
        let second = tokio::spawn(async move { second_state.try_join_room("race-room", "bob", "session-b") });
        let third = tokio::spawn(async move { third_state.try_join_room("race-room", "carol", "session-c") });
        let leases = [
            first.await.expect("join task must complete"),
            second.await.expect("join task must complete"),
            third.await.expect("join task must complete"),
        ];
        assert_eq!(leases.iter().filter(|result| result.is_ok()).count(), 2);
        assert_eq!(
            leases
                .iter()
                .filter(|result| matches!(result, Err(JoinRoomError::Full)))
                .count(),
            1
        );
    }

    #[test]
    fn websocket_global_and_per_user_limits_release_on_drop() {
        let mut config = config_with_user();
        config.max_ws_connections = 1;
        config.max_ws_per_user = 1;
        let state = AppState::new(config);

        let global = state.try_acquire_ws_slot().expect("first global slot");
        assert!(state.try_acquire_ws_slot().is_none());
        drop(global);
        assert!(state.try_acquire_ws_slot().is_some());

        let user = state.try_reserve_user_connection("alice").expect("first user slot");
        assert!(state.try_reserve_user_connection("alice").is_none());
        drop(user);
        assert!(state.try_reserve_user_connection("alice").is_some());
    }

    #[tokio::test]
    async fn websocket_rejects_invalid_ticket_before_upgrade() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener must bind");
        let address = listener.local_addr().expect("test address must resolve");
        let server = tokio::spawn(async move {
            axum::serve(listener, app(AppState::new(config_with_user())))
                .await
                .expect("test server must run");
        });

        let mut stream = tokio::net::TcpStream::connect(address)
            .await
            .expect("test client must connect");
        let request = format!(
            "GET /ws?ticket=invalid HTTP/1.1\r\nHost: {address}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .expect("test handshake must write");
        let mut response = [0_u8; 512];
        let size =
            tokio::time::timeout(std::time::Duration::from_secs(2), stream.read(&mut response))
                .await
                .expect("test handshake must not time out")
                .expect("test response must read");
        assert!(
            String::from_utf8_lossy(&response[..size]).starts_with("HTTP/1.1 401")
        );
        server.abort();
    }

    #[test]
    fn readiness_reflects_turn_and_shutdown_state() {
        let mut config = config_with_user();
        config.embedded_turn = true;
        let state = AppState::new(config);
        assert!(!state.is_ready());
        state.set_turn_ready(true);
        assert!(state.is_ready());
        state.begin_shutdown();
        assert!(!state.is_ready());
    }
}
