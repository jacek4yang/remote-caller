use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use axum::extract::ws::{Message, WebSocket};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{select, time};

use crate::{
    auth::Claims,
    state::{AppState, RoomLease},
};

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

pub async fn handle_socket(
    mut socket: WebSocket,
    claims: Claims,
    state: AppState,
    room_lease: RoomLease,
) {
    state.metrics.active_connections.fetch_add(1, Ordering::Relaxed);
    state.metrics.total_connections.fetch_add(1, Ordering::Relaxed);
    let room = room_lease.room().clone();
    let mut receiver = room.sender.subscribe();
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
    let mut window_started = Instant::now();
    let mut window_messages = 0_u32;

    loop {
        select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) if text.len() <= 65_536 => {
                        if window_started.elapsed() >= Duration::from_secs(1) {
                            window_started = Instant::now();
                            window_messages = 0;
                        }
                        window_messages += 1;
                        if window_messages > 30 {
                            state.metrics.rejected_connections.fetch_add(1, Ordering::Relaxed);
                            break;
                        }
                        let Ok(signal) = serde_json::from_str::<ClientSignal>(&text) else { continue; };
                        if !matches!(signal.kind.as_str(), "offer" | "answer" | "ice-candidate" | "media-state") { continue; }
                        state.metrics.signaling_messages.fetch_add(1, Ordering::Relaxed);
                        let _ = room.sender.send(ServerEvent {
                            kind: signal.kind,
                            from: claims.sub.clone(),
                            display_name: Some(claims.name.clone()),
                            payload: Some(signal.payload),
                        });
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            outgoing = receiver.recv() => {
                match outgoing {
                    Ok(event) if event.from != claims.sub => {
                        let Ok(text) = serde_json::to_string(&event) else { continue; };
                        if socket.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    _ => {}
                }
            }
            _ = ping.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
        }
    }

    let _ = room.sender.send(ServerEvent {
        kind: "peer-left".into(),
        from: claims.sub,
        display_name: Some(claims.name),
        payload: None,
    });
    state.metrics.active_connections.fetch_sub(1, Ordering::Relaxed);
    drop(room_lease);
}
