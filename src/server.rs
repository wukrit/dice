use crate::physics::{self, Simulation, Swipe};
use axum::{
    Json, Router,
    extract::{
        ConnectInfo, Path, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, broadcast, mpsc};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
    trace::TraceLayer,
};
use uuid::Uuid;

pub const IDLE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_ROOMS: usize = 256;
const MAX_MEMBERS: usize = 128;
const MAX_ROLLS: usize = 1000;
const ROOM_BYTES: usize = 32 * 1024 * 1024;
const TOTAL_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    store: Arc<Mutex<Store>>,
    simulation_slots: Arc<Semaphore>,
    connections: Arc<Semaphore>,
    limits: Arc<Mutex<HashMap<IpAddr, (Instant, u32)>>>,
}
#[derive(Default)]
struct Store {
    rooms: HashMap<Uuid, Arc<LiveRoom>>,
    recording_bytes: usize,
}
struct LiveRoom {
    events: broadcast::Sender<Arc<str>>,
    data: Mutex<RoomData>,
    roll_lock: tokio::sync::Mutex<()>,
}
struct RoomData {
    created_at: DateTime<Utc>,
    touched: Instant,
    members: HashMap<Uuid, Seat>, // keyed by private member token
    rolls: Vec<Arc<StoredRoll>>,
    recording_bytes: usize,
}
struct Seat {
    member: Member,
    connections: usize,
}
struct StoredRoll {
    roll: Roll,
    recording: Arc<str>,
    event: Arc<str>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            store: Default::default(),
            simulation_slots: Arc::new(Semaphore::new(4)),
            connections: Arc::new(Semaphore::new(512)),
            limits: Default::default(),
        }
    }
}
impl AppState {
    pub fn start_cleanup(&self) {
        let store = Arc::downgrade(&self.store);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                let Some(store) = store.upgrade() else {
                    break;
                };
                store.lock().unwrap().expire_idle();
            }
        });
    }
    fn find_room(&self, id: Uuid) -> Result<Arc<LiveRoom>, AppError> {
        // Lock ordering is always store -> room, never room -> store.
        let mut store = self.store.lock().unwrap();
        store.expire_idle();
        let room = store.rooms.get(&id).ok_or_else(AppError::missing)?.clone();
        room.data.lock().unwrap().touched = Instant::now();
        Ok(room)
    }
    fn rate_limit(&self, ip: IpAddr) -> Result<(), AppError> {
        let mut limits = self.limits.lock().unwrap();
        limits.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(60));
        if limits.len() >= 10_000 && !limits.contains_key(&ip) {
            return Err(AppError::busy());
        }
        let entry = limits.entry(ip).or_insert((Instant::now(), 0));
        entry.1 += 1;
        if entry.1 > 60 {
            return Err(AppError(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many requests. Try again in a minute.".into(),
            ));
        }
        Ok(())
    }
}
impl Store {
    fn expire_idle(&mut self) {
        let mut released = 0;
        self.rooms.retain(|_, room| {
            let data = room.data.lock().unwrap();
            let expired = data.touched.elapsed() >= IDLE_TTL
                && data.members.values().all(|seat| seat.connections == 0);
            if expired {
                released += data.recording_bytes;
            }
            !expired
        });
        self.recording_bytes = self.recording_bytes.saturating_sub(released);
    }
}

pub fn router(state: AppState) -> Router {
    let dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "web/dist".into());
    Router::new()
        .route(
            "/healthz",
            get(|| async { Json(json!({"status":"ok","storage":"memory"})) }),
        )
        .route("/api/dice", get(|| async { Json(physics::catalog()) }))
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/{id}", get(room_info))
        .route("/api/rooms/{id}/join", post(join_room))
        .route("/api/rooms/{id}/rolls", get(history))
        .route("/api/rooms/{id}/rolls/{roll_id}", get(recording))
        .route("/api/rooms/{id}/ws", get(upgrade))
        .fallback_service(
            ServeDir::new(&dir).not_found_service(ServeFile::new(format!("{dir}/index.html"))),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[derive(Debug)]
struct AppError(StatusCode, String);
impl AppError {
    fn bad(message: &str) -> Self {
        Self(StatusCode::BAD_REQUEST, message.into())
    }
    fn missing() -> Self {
        Self(
            StatusCode::NOT_FOUND,
            "This room has expired or doesn't exist. Start a new room and share its link.".into(),
        )
    }
    fn busy() -> Self {
        Self(
            StatusCode::SERVICE_UNAVAILABLE,
            "The table is busy. Please try again in a moment.".into(),
        )
    }
}
impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
#[derive(Clone, Serialize)]
struct Member {
    id: Uuid,
    name: String,
}
#[derive(Deserialize)]
struct NameInput {
    name: String,
}
fn clean_name(name: &str) -> Result<String, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 32 || name.chars().any(char::is_control) {
        return Err(AppError::bad(
            "Enter a display name between 1 and 32 characters, without control characters.",
        ));
    }
    Ok(name.to_owned())
}
fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if std::env::var("TRUST_PROXY").as_deref() == Ok("true") {
        if let Some(ip) = headers
            .get("x-real-ip")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse().ok())
        {
            return ip;
        }
    }
    peer.ip()
}
async fn create_room(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<NameInput>,
) -> Result<Json<Value>, AppError> {
    state.rate_limit(client_ip(peer, &headers))?;
    let name = clean_name(&input.name)?;
    let room_id = Uuid::new_v4();
    let member = Member {
        id: Uuid::new_v4(),
        name,
    };
    let token = Uuid::new_v4();
    let mut store = state.store.lock().unwrap();
    store.expire_idle();
    if store.rooms.len() >= MAX_ROOMS {
        return Err(AppError(
            StatusCode::SERVICE_UNAVAILABLE,
            "All tables are occupied. Try creating a room later.".into(),
        ));
    }
    let room = Arc::new(LiveRoom {
        events: broadcast::channel(16).0,
        roll_lock: tokio::sync::Mutex::new(()),
        data: Mutex::new(RoomData {
            created_at: Utc::now(),
            touched: Instant::now(),
            members: HashMap::from([(
                token,
                Seat {
                    member: member.clone(),
                    connections: 0,
                },
            )]),
            rolls: Vec::new(),
            recording_bytes: 0,
        }),
    });
    store.rooms.insert(room_id, room);
    Ok(Json(
        json!({"room_id":room_id,"member":member,"token":token}),
    ))
}
async fn room_info(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, AppError> {
    let room = state.find_room(id)?;
    let data = room.data.lock().unwrap();
    Ok(Json(
        json!({"id":id,"created_at":data.created_at,"idle_ttl_seconds":IDLE_TTL.as_secs(),"max_rolls":MAX_ROLLS,"ephemeral":true}),
    ))
}
async fn join_room(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<NameInput>,
) -> Result<Json<Value>, AppError> {
    state.rate_limit(client_ip(peer, &headers))?;
    let member = Member {
        id: Uuid::new_v4(),
        name: clean_name(&input.name)?,
    };
    let token = Uuid::new_v4();
    let room = state.find_room(id)?;
    let mut data = room.data.lock().unwrap();
    if data.members.len() >= MAX_MEMBERS {
        return Err(AppError::bad(
            "This room has no more seats. Start a new room for your party.",
        ));
    }
    data.members.insert(
        token,
        Seat {
            member: member.clone(),
            connections: 0,
        },
    );
    Ok(Json(json!({"room_id":id,"member":member,"token":token})))
}

#[derive(Serialize, Clone)]
struct Roll {
    id: Uuid,
    sequence: i64,
    request_id: Uuid,
    member_id: Uuid,
    name: String,
    die: u16,
    value: u16,
    duration_ms: u32,
    created_at: DateTime<Utc>,
}
#[derive(Deserialize)]
struct HistoryQuery {
    before: Option<i64>,
    since: Option<i64>,
}
async fn history(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Value>, AppError> {
    if query.before.is_some() && query.since.is_some() {
        return Err(AppError::bad("Use either before or since, not both."));
    }
    let room = state.find_room(id)?;
    let data = room.data.lock().unwrap();
    let mut rolls: Vec<&Roll> = if let Some(since) = query.since {
        data.rolls
            .iter()
            .filter(|r| r.roll.sequence > since)
            .take(51)
            .map(|r| &r.roll)
            .collect()
    } else {
        data.rolls
            .iter()
            .rev()
            .filter(|r| r.roll.sequence < query.before.unwrap_or(i64::MAX))
            .take(51)
            .map(|r| &r.roll)
            .collect()
    };
    let has_more = rolls.len() > 50;
    rolls.truncate(50);
    Ok(Json(json!({"rolls":rolls,"has_more":has_more})))
}
async fn recording(
    State(state): State<AppState>,
    Path((id, roll_id)): Path<(Uuid, Uuid)>,
) -> Result<Response, AppError> {
    let room = state.find_room(id)?;
    let recording = room
        .data
        .lock()
        .unwrap()
        .rolls
        .iter()
        .find(|r| r.roll.id == roll_id)
        .cloned()
        .ok_or_else(|| {
            AppError(
                StatusCode::NOT_FOUND,
                "That roll isn't in this room.".into(),
            )
        })?;
    Ok((
        [(header::CONTENT_TYPE, "application/json")],
        recording.recording.to_string(),
    )
        .into_response())
}
fn valid_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    if let Ok(expected) = std::env::var("PUBLIC_ORIGIN") {
        return origin == expected.trim_end_matches('/');
    }
    let Ok(uri) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    matches!(uri.scheme_str(), Some("http" | "https"))
        && uri.authority().map(|a| a.as_str())
            == headers.get(header::HOST).and_then(|h| h.to_str().ok())
}
async fn upgrade(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    if !valid_origin(&headers) {
        return Err(AppError(
            StatusCode::FORBIDDEN,
            "Connect from the app's own origin.".into(),
        ));
    }
    state.rate_limit(client_ip(peer, &headers))?;
    let permit = state
        .connections
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::busy())?;
    Ok(ws
        .max_message_size(16 * 1024)
        .max_frame_size(16 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            if let Err(error) = connection(socket, state, id).await {
                tracing::debug!(%error, "Socket closed");
            }
        }))
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Hello {
        token: Uuid,
    },
    Roll {
        request_id: Uuid,
        die: u16,
        swipe: Swipe,
    },
    Ping,
}
fn current_members(data: &RoomData) -> Vec<Member> {
    let mut members: Vec<_> = data
        .members
        .values()
        .filter(|seat| seat.connections > 0)
        .map(|seat| seat.member.clone())
        .collect();
    members.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
    members
}
fn presence(room: &LiveRoom) -> Arc<str> {
    json!({"type":"presence","members":current_members(&room.data.lock().unwrap())})
        .to_string()
        .into()
}
struct PresenceGuard {
    room: Arc<LiveRoom>,
    token: Uuid,
}
impl Drop for PresenceGuard {
    fn drop(&mut self) {
        let mut data = self.room.data.lock().unwrap();
        if let Some(seat) = data.members.get_mut(&self.token) {
            seat.connections = seat.connections.saturating_sub(1);
        }
        data.touched = Instant::now(); // expiry starts after the last connection leaves
        drop(data);
        let _ = self.room.events.send(presence(&self.room));
    }
}
async fn session_error(socket: &mut WebSocket, message: &str) -> anyhow::Result<()> {
    socket
        .send(Message::Text(
            json!({"type":"error","message":message}).to_string().into(),
        ))
        .await?;
    socket
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code: 4001,
            reason: "Room or seat expired".into(),
        })))
        .await?;
    Ok(())
}
async fn connection(mut socket: WebSocket, state: AppState, id: Uuid) -> anyhow::Result<()> {
    let first = tokio::time::timeout(Duration::from_secs(8), socket.recv()).await?;
    let token = match first {
        Some(Ok(Message::Text(text))) => match serde_json::from_str::<ClientMessage>(&text) {
            Ok(ClientMessage::Hello { token }) => token,
            _ => anyhow::bail!("Expected hello"),
        },
        _ => anyhow::bail!("Missing hello"),
    };
    let room = match state.find_room(id) {
        Ok(room) => room,
        Err(error) => return session_error(&mut socket, &error.1).await,
    };
    let member = room
        .data
        .lock()
        .unwrap()
        .members
        .get(&token)
        .map(|seat| seat.member.clone());
    let Some(member) = member else {
        return session_error(
            &mut socket,
            "Your room session expired. Rejoin with your name.",
        )
        .await;
    };
    let mut events = room.events.subscribe();
    let full = {
        let mut data = room.data.lock().unwrap();
        if data
            .members
            .values()
            .map(|seat| seat.connections)
            .sum::<usize>()
            >= 32
        {
            true
        } else {
            data.members.get_mut(&token).unwrap().connections += 1;
            false
        }
    };
    if full {
        socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4002,
                reason: "Room is full (32 connections).".into(),
            })))
            .await?;
        return Ok(());
    }
    let _guard = PresenceGuard {
        room: room.clone(),
        token,
    };
    let welcome = {
        let data = room.data.lock().unwrap();
        json!({"type":"welcome","member":member,"members":current_members(&data),"latest_sequence":data.rolls.len()})
    };
    socket
        .send(Message::Text(welcome.to_string().into()))
        .await?;
    let _ = room.events.send(presence(&room));
    let (out, mut replies) = mpsc::channel::<Arc<str>>(16);
    let (mut send, mut receive) = socket.split();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    let mut last_seen = Instant::now();
    let mut last_roll = Instant::now() - Duration::from_secs(2);
    let mut message_window = (Instant::now(), 0u32);
    loop {
        let outgoing = tokio::select! {
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(75) { break; }
                Some(Message::Ping(Vec::new().into()))
            }
            reply = replies.recv() => reply.map(|reply| Message::Text(reply.to_string().into())),
            event = events.recv() => match event {
                Ok(event) => Some(Message::Text(event.to_string().into())),
                // Slow/suspended phones reconnect and recover from the room's bounded history.
                Err(_) => break,
            },
            incoming = receive.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        last_seen = Instant::now();
                        if message_window.0.elapsed() >= Duration::from_secs(1) { message_window = (Instant::now(), 0); }
                        message_window.1 += 1;
                        if message_window.1 > 12 { break; }
                        match serde_json::from_str::<ClientMessage>(&text) {
                            Ok(ClientMessage::Ping) => Some(Message::Text(json!({"type":"pong"}).to_string().into())),
                            Ok(ClientMessage::Roll{request_id,die,swipe}) => {
                                if last_roll.elapsed() < Duration::from_millis(800) {
                                    Some(Message::Text(json!({"type":"error","request_id":request_id,"message":"Give the dice a moment before rolling again."}).to_string().into()))
                                } else if let Err(error) = validate_roll(die, &swipe) {
                                    Some(Message::Text(json!({"type":"error","request_id":request_id,"message":error.1}).to_string().into()))
                                } else {
                                    last_roll = Instant::now();
                                    let state = state.clone(); let room = room.clone(); let member = member.clone(); let out = out.clone();
                                    tokio::spawn(async move {
                                        if let Err(error) = process_roll(state,room,id,member,request_id,die,swipe,&out).await {
                                            let _ = out.send(json!({"type":"error","request_id":request_id,"message":error.1}).to_string().into()).await;
                                        }
                                    });
                                    None
                                }
                            }
                            _ => Some(Message::Text(json!({"type":"error","message":"Unrecognized room message."}).to_string().into())),
                        }
                    }
                    Some(Ok(Message::Pong(_))) => { last_seen=Instant::now(); None }
                    Some(Ok(Message::Ping(data))) => { last_seen=Instant::now(); Some(Message::Pong(data)) }
                    _ => break,
                }
            }
        };
        if let Some(message) = outgoing {
            if !matches!(
                tokio::time::timeout(Duration::from_secs(10), send.send(message)).await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
    }
    Ok(())
}
fn validate_roll(die: u16, swipe: &Swipe) -> Result<(), AppError> {
    if ![4, 6, 8, 10, 12, 20, 100].contains(&die) {
        return Err(AppError::bad("Choose a supported die."));
    }
    if !swipe
        .start
        .iter()
        .chain(swipe.delta.iter())
        .chain(std::iter::once(&swipe.duration_ms))
        .all(|value| value.is_finite())
        || swipe.start.iter().any(|v| v.abs() > 1.01)
        || swipe.delta.iter().any(|v| v.abs() > 3.0)
        || !(60.0..=1200.0).contains(&swipe.duration_ms)
    {
        return Err(AppError::bad(
            "That swipe couldn't be read. Try another throw.",
        ));
    }
    Ok(())
}
// Serialize f32 poses ONCE. HTTP replay, live broadcast, and idempotent retry all use
// these canonical bytes, avoiding float precision differences between serde paths.
fn encode_recording(roll: Roll, simulation: &Simulation) -> StoredRoll {
    #[derive(Serialize)]
    struct Recording<'a> {
        roll: &'a Roll,
        simulation: &'a Simulation,
    }
    let recording = serde_json::to_string(&Recording {
        roll: &roll,
        simulation,
    })
    .expect("finite validated simulation");
    let event = format!("{{\"type\":\"roll\",{}", &recording[1..]);
    StoredRoll {
        roll,
        recording: recording.into(),
        event: event.into(),
    }
}
#[allow(clippy::too_many_arguments)]
async fn process_roll(
    state: AppState,
    room: Arc<LiveRoom>,
    room_id: Uuid,
    member: Member,
    request_id: Uuid,
    die: u16,
    swipe: Swipe,
    out: &mpsc::Sender<Arc<str>>,
) -> Result<(), AppError> {
    let _slot = state
        .simulation_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::busy())?;
    let _lock = room.roll_lock.lock().await;
    let existing = room
        .data
        .lock()
        .unwrap()
        .rolls
        .iter()
        .find(|r| r.roll.request_id == request_id)
        .cloned();
    if let Some(recording) = existing {
        if recording.roll.member_id != member.id {
            return Err(AppError::bad("That request ID belongs to another player."));
        }
        let _ = out.send(recording.event.clone()).await;
        return Ok(());
    }
    if room.data.lock().unwrap().rolls.len() >= MAX_ROLLS {
        return Err(AppError::bad(
            "This room has reached 1,000 rolls. Start a fresh room to keep playing.",
        ));
    }
    let _ = out
        .send(
            json!({"type":"accepted","request_id":request_id})
                .to_string()
                .into(),
        )
        .await;
    let simulation = tokio::task::spawn_blocking(move || physics::simulate(die, swipe))
        .await
        .map_err(|error| {
            tracing::error!(%error,"Simulation task failed");
            AppError::busy()
        })?
        .map_err(|error| {
            tracing::warn!(%error,"Die did not settle");
            AppError::bad("The die didn't settle flat. Please roll again.")
        })?;
    let mut store = state.store.lock().unwrap();
    if !store
        .rooms
        .get(&room_id)
        .is_some_and(|stored| Arc::ptr_eq(stored, &room))
    {
        return Err(AppError::missing());
    }
    let mut data = room.data.lock().unwrap();
    let roll = Roll {
        id: Uuid::new_v4(),
        sequence: data.rolls.len() as i64 + 1,
        request_id,
        member_id: member.id,
        name: member.name,
        die,
        value: simulation.value,
        duration_ms: simulation.duration_ms,
        created_at: Utc::now(),
    };
    let recording = Arc::new(encode_recording(roll, &simulation));
    let bytes = recording.recording.len() + recording.event.len();
    if data.recording_bytes + bytes > ROOM_BYTES || store.recording_bytes + bytes > TOTAL_BYTES {
        return Err(AppError::bad(
            "The server's temporary replay storage is full. Try later or start a fresh session after old rooms expire.",
        ));
    }
    data.recording_bytes += bytes;
    store.recording_bytes += bytes;
    data.touched = Instant::now();
    data.rolls.push(recording.clone());
    // Commit to memory before announcing; no awaits occur between insertion and fan-out.
    let _ = room.events.send(recording.event.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty_room(age: Duration, connected: bool, bytes: usize) -> Arc<LiveRoom> {
        Arc::new(LiveRoom {
            events: broadcast::channel(16).0,
            roll_lock: tokio::sync::Mutex::new(()),
            data: Mutex::new(RoomData {
                created_at: Utc::now(),
                touched: Instant::now() - age,
                recording_bytes: bytes,
                rolls: vec![],
                members: HashMap::from([(
                    Uuid::new_v4(),
                    Seat {
                        member: Member {
                            id: Uuid::new_v4(),
                            name: "Mira".into(),
                        },
                        connections: usize::from(connected),
                    },
                )]),
            }),
        })
    }
    #[test]
    fn names_are_trimmed_but_never_empty() {
        assert_eq!(clean_name("  Mira  ").ok().as_deref(), Some("Mira"));
        assert!(clean_name("   ").is_err());
        assert!(clean_name("bad\nname").is_err());
        assert!(clean_name(&"a".repeat(33)).is_err());
        assert!(clean_name("Éowyn 🎲").is_ok());
    }
    #[test]
    fn rejects_invalid_swipes() {
        let mut swipe = Swipe {
            start: [0.0, 0.0],
            delta: [0.1, -0.8],
            duration_ms: 250.0,
        };
        assert!(validate_roll(20, &swipe).is_ok());
        assert!(validate_roll(7, &swipe).is_err());
        swipe.delta[0] = f32::NAN;
        assert!(validate_roll(20, &swipe).is_err());
    }
    #[test]
    fn websocket_origin_must_match_host() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("example.test"));
        assert!(!valid_origin(&headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.test"),
        );
        assert!(!valid_origin(&headers));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://example.test"),
        );
        assert!(valid_origin(&headers));
    }
    #[test]
    fn idle_rooms_expire_and_free_recording_budget_but_connected_rooms_survive() {
        let expired = Uuid::new_v4();
        let live = Uuid::new_v4();
        let fresh = Uuid::new_v4();
        let mut store = Store {
            rooms: HashMap::from([
                (
                    expired,
                    empty_room(IDLE_TTL + Duration::from_secs(1), false, 123),
                ),
                (
                    live,
                    empty_room(IDLE_TTL + Duration::from_secs(1), true, 45),
                ),
                (fresh, empty_room(Duration::from_secs(1), false, 67)),
            ]),
            recording_bytes: 235,
        };
        store.expire_idle();
        assert!(!store.rooms.contains_key(&expired));
        assert_eq!(store.rooms.len(), 2);
        assert_eq!(store.recording_bytes, 112);
    }
    #[test]
    fn replay_and_broadcast_have_identical_float_values() {
        let roll = Roll {
            id: Uuid::new_v4(),
            sequence: 1,
            request_id: Uuid::new_v4(),
            member_id: Uuid::new_v4(),
            name: "Mira".into(),
            die: 20,
            value: 7,
            duration_ms: 1000,
            created_at: Utc::now(),
        };
        let simulation = Simulation {
            duration_ms: 1000,
            value: 7,
            tracks: vec![physics::Track {
                kind: 20,
                value: 7,
                frames: vec![physics::Frame {
                    t: 0,
                    p: [1.15, 0.12345679, 0.0],
                    q: [0.0, 0.0, 0.0, 1.0],
                }],
            }],
        };
        let stored = encode_recording(roll, &simulation);
        let http: Value = serde_json::from_str(&stored.recording).unwrap();
        let ws: Value = serde_json::from_str(&stored.event).unwrap();
        assert_eq!(http["simulation"], ws["simulation"]);
        assert_eq!(http["roll"], ws["roll"]);
    }
    #[test]
    fn a_fresh_process_has_no_previous_rooms() {
        let first = AppState::default();
        let id = Uuid::new_v4();
        first
            .store
            .lock()
            .unwrap()
            .rooms
            .insert(id, empty_room(Duration::ZERO, false, 0));
        assert!(first.find_room(id).is_ok());
        assert!(AppState::default().find_room(id).is_err());
    }
    #[tokio::test]
    async fn history_pages_are_bounded_and_cursor_exclusive() {
        let state = AppState::default();
        let id = Uuid::new_v4();
        let room = empty_room(Duration::ZERO, false, 0);
        for sequence in 1..=55 {
            let roll = Roll {
                id: Uuid::new_v4(),
                sequence,
                request_id: Uuid::new_v4(),
                member_id: Uuid::new_v4(),
                name: "Mira".into(),
                die: 20,
                value: 1,
                duration_ms: 0,
                created_at: Utc::now(),
            };
            room.data
                .lock()
                .unwrap()
                .rolls
                .push(Arc::new(encode_recording(
                    roll,
                    &Simulation {
                        duration_ms: 0,
                        value: 1,
                        tracks: vec![],
                    },
                )));
        }
        state.store.lock().unwrap().rooms.insert(id, room);
        let Json(page) = history(
            State(state.clone()),
            Path(id),
            Query(HistoryQuery {
                before: None,
                since: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(page["rolls"].as_array().unwrap().len(), 50);
        assert_eq!(page["has_more"], true);
        assert_eq!(page["rolls"][0]["sequence"], 55);
        let Json(page) = history(
            State(state.clone()),
            Path(id),
            Query(HistoryQuery {
                before: Some(6),
                since: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(page["rolls"].as_array().unwrap().len(), 5);
        assert_eq!(page["has_more"], false);
        assert_eq!(page["rolls"][0]["sequence"], 5);
        let Json(page) = history(
            State(state),
            Path(id),
            Query(HistoryQuery {
                before: None,
                since: Some(50),
            }),
        )
        .await
        .unwrap();
        assert_eq!(page["rolls"][0]["sequence"], 51);
        assert_eq!(page["rolls"].as_array().unwrap().len(), 5);
    }
    #[tokio::test]
    async fn simultaneous_retries_insert_one_roll() {
        let state = AppState::default();
        let id = Uuid::new_v4();
        let room = empty_room(Duration::ZERO, false, 0);
        let member = room
            .data
            .lock()
            .unwrap()
            .members
            .values()
            .next()
            .unwrap()
            .member
            .clone();
        state.store.lock().unwrap().rooms.insert(id, room.clone());
        let request = Uuid::new_v4();
        let (out, mut replies) = mpsc::channel(16);
        let swipe = Swipe {
            start: [0.0, 0.5],
            delta: [0.2, -0.8],
            duration_ms: 250.0,
        };
        let (a, b) = tokio::join!(
            process_roll(
                state.clone(),
                room.clone(),
                id,
                member.clone(),
                request,
                6,
                swipe.clone(),
                &out
            ),
            process_roll(
                state.clone(),
                room.clone(),
                id,
                member,
                request,
                6,
                swipe,
                &out
            )
        );
        assert!(a.is_ok());
        assert!(b.is_ok());
        let data = room.data.lock().unwrap();
        assert_eq!(data.rolls.len(), 1);
        let accepted: Value = serde_json::from_str(&replies.try_recv().unwrap()).unwrap();
        assert_eq!(accepted["type"], "accepted");
        assert_eq!(replies.try_recv().unwrap(), data.rolls[0].event);
    }
    #[test]
    fn leaving_the_last_seat_refreshes_room_expiry() {
        let room = empty_room(IDLE_TTL + Duration::from_secs(5), true, 0);
        let token = *room.data.lock().unwrap().members.keys().next().unwrap();
        drop(PresenceGuard {
            room: room.clone(),
            token,
        });
        let data = room.data.lock().unwrap();
        assert_eq!(data.members[&token].connections, 0);
        assert!(data.touched.elapsed() < Duration::from_secs(1));
    }
}
