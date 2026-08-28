use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};

use dashmap::{DashMap, mapref::entry::Entry};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast};
use uuid::Uuid;

use crate::{
    auth::{Claims, unix_time},
    config::Config,
    signal::ServerEvent,
};

pub struct Room {
    pub sender: broadcast::Sender<ServerEvent>,
    pub peers: AtomicUsize,
    _slot: OwnedSemaphorePermit,
}

impl Room {
    fn new(slot: OwnedSemaphorePermit) -> Self {
        let (sender, _) = broadcast::channel(64);
        Self {
            sender,
            peers: AtomicUsize::new(1),
            _slot: slot,
        }
    }
}

#[derive(Debug)]
pub enum JoinRoomError {
    Full,
    Capacity,
}

pub struct RoomLease {
    rooms: Arc<DashMap<String, Arc<Room>>>,
    room_id: String,
    room: Arc<Room>,
}

impl RoomLease {
    pub fn room(&self) -> &Arc<Room> {
        &self.room
    }
}

impl Drop for RoomLease {
    fn drop(&mut self) {
        if self.room.peers.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.rooms.remove_if(&self.room_id, |_, current| {
                Arc::ptr_eq(current, &self.room) && current.peers.load(Ordering::Acquire) == 0
            });
        }
    }
}

pub struct UserConnectionLease {
    counters: Arc<DashMap<String, usize>>,
    username: String,
}

impl Drop for UserConnectionLease {
    fn drop(&mut self) {
        if let Some(mut count) = self.counters.get_mut(&self.username) {
            *count = (*count).saturating_sub(1);
            let remove = *count == 0;
            drop(count);
            if remove {
                self.counters.remove_if(&self.username, |_, current| *current == 0);
            }
        }
    }
}

struct WsTicket {
    claims: Claims,
    room: String,
    expires_at: u64,
    _slot: OwnedSemaphorePermit,
}

#[derive(Default)]
pub struct Metrics {
    pub active_connections: AtomicU64,
    pub total_connections: AtomicU64,
    pub signaling_messages: AtomicU64,
    pub rejected_connections: AtomicU64,
    pub rejected_logins: AtomicU64,
    pub issued_ws_tickets: AtomicU64,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub rooms: Arc<DashMap<String, Arc<Room>>>,
    pub metrics: Arc<Metrics>,
    pub login_slots: Arc<Semaphore>,
    ws_slots: Arc<Semaphore>,
    room_slots: Arc<Semaphore>,
    ticket_slots: Arc<Semaphore>,
    user_connections: Arc<DashMap<String, usize>>,
    ws_tickets: Arc<DashMap<String, WsTicket>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let login_slots = config.auth_max_concurrent_hashes;
        let ws_slots = config.max_ws_connections;
        let room_slots = config.max_rooms;
        let ticket_slots = config.max_pending_ws_tickets;
        Self {
            config: Arc::new(config),
            rooms: Arc::new(DashMap::new()),
            metrics: Arc::new(Metrics::default()),
            login_slots: Arc::new(Semaphore::new(login_slots)),
            ws_slots: Arc::new(Semaphore::new(ws_slots)),
            room_slots: Arc::new(Semaphore::new(room_slots)),
            ticket_slots: Arc::new(Semaphore::new(ticket_slots)),
            user_connections: Arc::new(DashMap::new()),
            ws_tickets: Arc::new(DashMap::new()),
        }
    }

    /// Atomically joins an existing room while its DashMap shard remains
    /// guarded, preventing empty-room cleanup from racing with a new join.
    pub fn try_join_room(&self, id: &str) -> Result<RoomLease, JoinRoomError> {
        let room = match self.rooms.entry(id.to_owned()) {
            Entry::Occupied(entry) => {
                let room = entry.get().clone();
                let previous = room.peers.fetch_add(1, Ordering::AcqRel);
                if previous >= 2 {
                    room.peers.fetch_sub(1, Ordering::AcqRel);
                    return Err(JoinRoomError::Full);
                }
                room
            }
            Entry::Vacant(entry) => {
                let slot = self
                    .room_slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| JoinRoomError::Capacity)?;
                let room = Arc::new(Room::new(slot));
                entry.insert(room.clone());
                room
            }
        };
        Ok(RoomLease {
            rooms: self.rooms.clone(),
            room_id: id.to_owned(),
            room,
        })
    }

    pub fn try_acquire_ws_slot(&self) -> Option<OwnedSemaphorePermit> {
        self.ws_slots.clone().try_acquire_owned().ok()
    }

    pub fn try_reserve_user_connection(&self, username: &str) -> Option<UserConnectionLease> {
        let mut count = self.user_connections.entry(username.to_owned()).or_insert(0);
        if *count >= self.config.max_ws_per_user {
            return None;
        }
        *count += 1;
        drop(count);
        Some(UserConnectionLease {
            counters: self.user_connections.clone(),
            username: username.to_owned(),
        })
    }

    pub fn issue_ws_ticket(&self, claims: Claims, room: String) -> Option<(String, u64)> {
        // Drop abandoned tickets before applying the pending-ticket capacity
        // bound. Without this, 32 never-used tickets could hold permits until
        // process restart even though each ticket is only valid briefly.
        let now = unix_time();
        self.ws_tickets.retain(|_, ticket| ticket.expires_at > now);
        let slot = self.ticket_slots.clone().try_acquire_owned().ok()?;
        let expires_at = now.saturating_add(self.config.ws_ticket_ttl_secs);
        let ticket = Uuid::new_v4().to_string();
        self.ws_tickets.insert(
            ticket.clone(),
            WsTicket {
                claims,
                room,
                expires_at,
                _slot: slot,
            },
        );
        self.metrics.issued_ws_tickets.fetch_add(1, Ordering::Relaxed);
        Some((ticket, expires_at))
    }

    pub fn consume_ws_ticket(&self, ticket: &str) -> Option<(Claims, String)> {
        let (_, value) = self.ws_tickets.remove(ticket)?;
        if value.expires_at <= unix_time() {
            return None;
        }
        Some((value.claims, value.room))
    }
}
