use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

use dashmap::{DashMap, mapref::entry::Entry};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, oneshot};
use uuid::Uuid;

use crate::{
    auth::{Claims, unix_time},
    config::Config,
    signal::ServerEvent,
};

struct RoomMember {
    connection_id: String,
    cancel: oneshot::Sender<()>,
}

pub struct Room {
    pub sender: broadcast::Sender<ServerEvent>,
    members: Mutex<HashMap<String, RoomMember>>,
    _slot: OwnedSemaphorePermit,
}

impl Room {
    fn new(
        slot: OwnedSemaphorePermit,
        username: String,
        connection_id: String,
    ) -> (Self, oneshot::Receiver<()>) {
        let (cancel, cancelled) = oneshot::channel();
        let mut members = HashMap::with_capacity(2);
        members.insert(
            username,
            RoomMember {
                connection_id,
                cancel,
            },
        );
        let (sender, _) = broadcast::channel(64);
        (
            Self {
                sender,
                members: Mutex::new(members),
                _slot: slot,
            },
            cancelled,
        )
    }

    fn members(&self) -> MutexGuard<'_, HashMap<String, RoomMember>> {
        self.members
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn join(
        &self,
        username: String,
        connection_id: String,
    ) -> Result<oneshot::Receiver<()>, JoinRoomError> {
        let mut members = self.members();
        if !members.contains_key(&username) && members.len() >= 2 {
            return Err(JoinRoomError::Full);
        }

        let (cancel, cancelled) = oneshot::channel();
        if let Some(previous) = members.insert(
            username,
            RoomMember {
                connection_id,
                cancel,
            },
        ) {
            // A reconnect atomically supersedes its stale socket instead of
            // temporarily consuming a third room seat.
            let _ = previous.cancel.send(());
        }
        Ok(cancelled)
    }

    fn is_current(&self, username: &str, connection_id: &str) -> bool {
        self.members()
            .get(username)
            .is_some_and(|member| member.connection_id == connection_id)
    }

    fn leave(&self, username: &str, connection_id: &str) -> bool {
        let mut members = self.members();
        if members
            .get(username)
            .is_some_and(|member| member.connection_id == connection_id)
        {
            members.remove(username);
        }
        members.is_empty()
    }

    pub fn member_count(&self) -> usize {
        self.members().len()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum JoinRoomError {
    Full,
    Capacity,
}

pub struct RoomLease {
    rooms: Arc<DashMap<String, Arc<Room>>>,
    room_id: String,
    room: Arc<Room>,
    username: String,
    connection_id: String,
    cancelled: Option<oneshot::Receiver<()>>,
}

impl RoomLease {
    pub fn room(&self) -> &Arc<Room> {
        &self.room
    }

    pub fn take_cancelled(&mut self) -> oneshot::Receiver<()> {
        self.cancelled.take().unwrap_or_else(|| {
            let (_cancel, cancelled) = oneshot::channel();
            cancelled
        })
    }

    pub fn is_current(&self) -> bool {
        self.room
            .is_current(&self.username, &self.connection_id)
    }
}

impl Drop for RoomLease {
    fn drop(&mut self) {
        if self.room.leave(&self.username, &self.connection_id) {
            self.rooms.remove_if(&self.room_id, |_, current| {
                Arc::ptr_eq(current, &self.room) && current.member_count() == 0
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
                self.counters
                    .remove_if(&self.username, |_, current| *current == 0);
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
    pub rejected_signaling_messages: AtomicU64,
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
    accepting: Arc<AtomicBool>,
    turn_ready: Arc<AtomicBool>,
    shutdown: broadcast::Sender<()>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let login_slots = config.auth_max_concurrent_hashes;
        let ws_slots = config.max_ws_connections;
        let room_slots = config.max_rooms;
        let ticket_slots = config.max_pending_ws_tickets;
        let turn_ready = !config.embedded_turn;
        let (shutdown, _) = broadcast::channel(1);
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
            accepting: Arc::new(AtomicBool::new(true)),
            turn_ready: Arc::new(AtomicBool::new(turn_ready)),
            shutdown,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.accepting.load(Ordering::Acquire) && self.turn_ready.load(Ordering::Acquire)
    }

    pub fn set_turn_ready(&self, ready: bool) {
        self.turn_ready.store(ready, Ordering::Release);
    }

    pub fn begin_shutdown(&self) {
        self.accepting.store(false, Ordering::Release);
        let _ = self.shutdown.send(());
    }

    pub fn is_accepting(&self) -> bool {
        self.accepting.load(Ordering::Acquire)
    }

    pub fn subscribe_shutdown(&self) -> broadcast::Receiver<()> {
        self.shutdown.subscribe()
    }

    /// Atomically joins an existing room while its DashMap shard remains
    /// guarded, preventing empty-room cleanup from racing with a new join.
    /// A reconnect for the same account replaces the stale socket and does not
    /// consume a third participant seat.
    pub fn try_join_room(
        &self,
        id: &str,
        username: &str,
        connection_id: &str,
    ) -> Result<RoomLease, JoinRoomError> {
        let username = username.to_owned();
        let connection_id = connection_id.to_owned();
        let (room, cancelled) = match self.rooms.entry(id.to_owned()) {
            Entry::Occupied(entry) => {
                let room = entry.get().clone();
                let cancelled = room.join(username.clone(), connection_id.clone())?;
                (room, cancelled)
            }
            Entry::Vacant(entry) => {
                let slot = self
                    .room_slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| JoinRoomError::Capacity)?;
                let (room, cancelled) =
                    Room::new(slot, username.clone(), connection_id.clone());
                let room = Arc::new(room);
                entry.insert(room.clone());
                (room, cancelled)
            }
        };
        Ok(RoomLease {
            rooms: self.rooms.clone(),
            room_id: id.to_owned(),
            room,
            username,
            connection_id,
            cancelled: Some(cancelled),
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
        self.metrics
            .issued_ws_tickets
            .fetch_add(1, Ordering::Relaxed);
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
