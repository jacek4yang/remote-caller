use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use axum::extract::ws::{CloseFrame, Message, WebSocket, close_code};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{select, time};

use crate::{
    auth::Claims,
    state::{AppState, RoomLease},
};

pub const MAX_SIGNAL_MESSAGE_SIZE: usize = 65_536;
const MAX_SIGNAL_MESSAGES_PER_SECOND: u32 = 30;

struct MessageRateLimit {
    window_started: Instant,
    messages: u32,
}

impl MessageRateLimit {
    fn new() -> Self {
        Self {
            window_started: Instant::now(),
            messages: 0,
        }
    }

    fn accept(&mut self) -> bool {
        if self.window_started.elapsed() >= Duration::from_secs(1) {
            self.window_started = Instant::now();
            self.messages = 0;
        }
        self.messages += 1;
        self.messages <= MAX_SIGNAL_MESSAGES_PER_SECOND
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientSignal {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    #[serde(rename = "type")]
    pub kind: String,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

pub async fn handle_socket(mut socket: WebSocket, claims: Claims, state: AppState, mut room_lease: RoomLease) {
    state.metrics.active_connections.fetch_add(1, Ordering::Relaxed);
    state.metrics.total_connections.fetch_add(1, Ordering::Relaxed);
    let room = room_lease.room().clone();
    let mut receiver = room.sender.subscribe();
    let mut cancelled = room_lease.take_cancelled();
    let mut shutting_down = state.subscribe_shutdown();
    let ready = json!({"type":"ready", "clientId": claims.sub});
    if socket.send(Message::Text(ready.to_string().into())).await.is_err() {
        state.metrics.active_connections.fetch_sub(1, Ordering::Relaxed);
        return;
    }

    let joined = ServerEvent {
        kind: "peer-joined".into(),
        from: claims.sub.clone(),
        display_name: Some(claims.name.clone()),
        payload: None,
    };
    let _ = room.sender.send(joined);

    // Application-level heartbeat keeps Nginx and mobile NAT mappings alive.
    let mut ping = time::interval(Duration::from_secs(20));
    ping.set_missed_tick_behavior(time::MissedTickBehavior::Delay);
    let mut rate_limit = MessageRateLimit::new();
    let mut last_received = Instant::now();

    loop {
        select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) if text.len() <= MAX_SIGNAL_MESSAGE_SIZE => {
                        last_received = Instant::now();
                        if !rate_limit.accept() {
                            state.metrics.rejected_signaling_messages.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                        let Ok(signal) = serde_json::from_str::<ClientSignal>(&text) else {
                            state.metrics.rejected_signaling_messages.fetch_add(1, Ordering::Relaxed);
                            continue;
                        };
                        if !matches!(signal.kind.as_str(), "offer" | "answer" | "ice-candidate" | "media-state") {
                            state.metrics.rejected_signaling_messages.fetch_add(1, Ordering::Relaxed);
                            continue;
                        }
                        state.metrics.signaling_messages.fetch_add(1, Ordering::Relaxed);
                        let _ = room.sender.send(ServerEvent {
                            kind: signal.kind,
                            from: claims.sub.clone(),
                            display_name: Some(claims.name.clone()),
                            payload: Some(signal.payload),
                        });
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Ping(_))) => {
                        last_received = Instant::now();
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {
                        state.metrics.rejected_signaling_messages.fetch_add(1, Ordering::Relaxed);
                        break;
                    }
                }
            }
            outgoing = receiver.recv() => {
                match outgoing {
                    Ok(event) if event.from != claims.sub => {
                        let Ok(text) = serde_json::to_string(&event) else { continue; };
                        if socket.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Signaling is ordered and cannot safely skip an SDP or
                        // candidate. Reconnect rather than continue corrupted.
                        state.metrics.rejected_signaling_messages.fetch_add(1, Ordering::Relaxed);
                        break;
                    }
                }
            }
            _ = ping.tick() => {
                if last_received.elapsed() > Duration::from_secs(60) { break; }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
            _ = &mut cancelled => break,
            _ = shutting_down.recv() => {
                let _ = socket.send(Message::Close(Some(CloseFrame {
                    code: close_code::AWAY,
                    reason: "service restart".into(),
                }))).await;
                break;
            }
        }
    }

    if room_lease.is_current() {
        let _ = room.sender.send(ServerEvent {
            kind: "peer-left".into(),
            from: claims.sub,
            display_name: Some(claims.name),
            payload: None,
        });
    }
    state.metrics.active_connections.fetch_sub(1, Ordering::Relaxed);
    drop(room_lease);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signaling_json_is_strictly_typed() {
        let valid = serde_json::from_str::<ClientSignal>(r#"{"type":"offer","payload":{"type":"offer","sdp":"v=0"}}"#);
        assert!(valid.is_ok());
        assert!(serde_json::from_str::<ClientSignal>("{").is_err());
        assert!(serde_json::from_str::<ClientSignal>(r#"{"type":1}"#).is_err());
    }

    #[test]
    fn signaling_rate_limit_rejects_message_thirty_one() {
        let mut limit = MessageRateLimit::new();
        for _ in 0..MAX_SIGNAL_MESSAGES_PER_SECOND {
            assert!(limit.accept());
        }
        assert!(!limit.accept());
    }
}
