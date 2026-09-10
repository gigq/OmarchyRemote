mod herdr;
mod terminal;

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use terminal::{Sessions, Terminal};
use tokio::time::{MissedTickBehavior, interval, timeout};

#[derive(Clone)]
struct App {
    token: Arc<String>,
    origins: Arc<Vec<String>>,
    sessions: Sessions,
    herdr: herdr::Herdr,
}
type ApiError = (StatusCode, Json<Value>);
fn error(e: impl std::fmt::Display) -> ApiError {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({"error":e.to_string()})),
    )
}

async fn authorize(
    State(app): State<App>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if headers.get("x-omarchy-proxy").and_then(|v| v.to_str().ok()) != Some(app.token.as_str()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    let websocket = headers.get("upgrade").is_some();
    if !authorized_browser(
        &app.origins,
        origin,
        websocket,
        headers
            .get("x-hyprland-client")
            .and_then(|v| v.to_str().ok()),
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}
fn authorized_browser(
    origins: &[String],
    origin: Option<&str>,
    websocket: bool,
    client: Option<&str>,
) -> bool {
    if let Some(origin) = origin
        && !origins.iter().any(|allowed| allowed == origin)
    {
        return false;
    }
    if websocket {
        origin.is_some()
    } else {
        client == Some("1")
    }
}
async fn capabilities() -> Json<Value> {
    Json(
        json!({"version":1,"host":std::env::var("HOSTNAME").unwrap_or_else(|_|"host".into()),"apps":[{"id":"terminal","name":"Terminal","features":["pty","resize","reconnect"]},{"id":"herdr","name":"Herdr","features":["workspaces","agents","panes","input"]}]}),
    )
}
#[derive(Deserialize)]
struct SessionRequest {
    id: Option<String>,
}
async fn session(
    State(app): State<App>,
    Json(req): Json<SessionRequest>,
) -> Result<Json<Value>, ApiError> {
    let sessions = app.sessions.clone();
    tokio::task::spawn_blocking(move || {
        let mut sessions = sessions.lock().unwrap();
        if let Some(id) = req.id
            && let Some(terminal) = sessions.get(&id)
        {
            return Ok(Json(
                json!({"id":id,"exited":terminal.output.lock().unwrap().exited,"resumed":true}),
            ));
        }
        sessions.retain(|_, t| !t.output.lock().unwrap().exited);
        if sessions.len() >= 8 {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"Eight shells are already open. Exit an unused shell first."})),
            ));
        }
        let terminal = Terminal::spawn().map_err(error)?;
        let id = uuid::Uuid::new_v4().to_string();
        sessions.insert(id.clone(), terminal);
        Ok(Json(json!({"id":id,"exited":false,"resumed":false})))
    })
    .await
    .map_err(error)?
}
async fn terminal_upgrade(
    State(app): State<App>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let terminal = app.sessions.lock().unwrap().get(&id).cloned().ok_or((
        StatusCode::NOT_FOUND,
        Json(json!({"error":"Session not found"})),
    ))?;
    Ok(ws
        .max_message_size(32768)
        .on_upgrade(move |socket| terminal_socket(socket, terminal)))
}
async fn send(socket: &mut WebSocket, value: Value) -> bool {
    matches!(
        timeout(
            Duration::from_secs(5),
            socket.send(Message::Text(value.to_string().into()))
        )
        .await,
        Ok(Ok(()))
    )
}
async fn terminal_socket(mut socket: WebSocket, terminal: Arc<Terminal>) {
    let (mut events, mut sequence, screen, cols, rows, exited) = {
        let out = terminal.output.lock().unwrap();
        let (rows, cols) = out.parser.screen().size();
        (
            terminal.events.subscribe(),
            out.sequence,
            out.parser.screen().contents_formatted(),
            cols,
            rows,
            out.exited,
        )
    };
    if !send(
        &mut socket,
        json!({"type":"screen","data":screen,"cols":cols,"rows":rows,"exited":exited}),
    )
    .await
    {
        return;
    }
    let mut heartbeat = interval(Duration::from_secs(15));
    let mut last_pong = std::time::Instant::now();
    loop {
        tokio::select! {
            event=events.recv()=>match event {
                Ok((seq,bytes)) if seq>sequence=>{sequence=seq; if bytes.is_empty(){let _=send(&mut socket,json!({"type":"exit"})).await;break}
                if !send(&mut socket,json!({"type":"output","data":bytes})).await{break} },
                Ok(_)=>{},
                Err(_)=>break, // reconnect obtains a fresh terminal screen if a client fell behind
            },
            event=socket.next()=>match event {
                Some(Ok(Message::Text(text)))=>{
                    let result=match serde_json::from_str::<Value>(&text) {
                        Ok(v)=>match v["type"].as_str(){
                            Some("input")=>terminal.input(v["data"].as_str().unwrap_or("").as_bytes()),
                            Some("resize")=>terminal.resize(v["cols"].as_u64().unwrap_or(80).min(300) as u16,v["rows"].as_u64().unwrap_or(24).min(150) as u16),
                            _=>Err(anyhow::anyhow!("Unknown terminal message")),
                        },Err(e)=>Err(e.into()),
                    };
                    if let Err(e)=result && !send(&mut socket,json!({"type":"error","message":e.to_string()})).await{break}
                },
                Some(Ok(Message::Pong(_)))=>{last_pong=std::time::Instant::now()},
                Some(Ok(Message::Ping(bytes)))=>{if socket.send(Message::Pong(bytes)).await.is_err(){break}},
                _=>break,
            },
            _=heartbeat.tick()=>{if last_pong.elapsed()>Duration::from_secs(45){break}
                if !matches!(timeout(Duration::from_secs(5),socket.send(Message::Ping(Vec::new().into()))).await,Ok(Ok(()))){break}},
        }
    }
}
async fn snapshot(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    Ok(Json(app.herdr.snapshot().await.map_err(error)?))
}
async fn pane(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    Ok(Json(app.herdr.read(&id).await.map_err(error)?))
}
#[derive(Deserialize)]
struct PaneInput {
    #[serde(default)]
    text: String,
    #[serde(default)]
    keys: Vec<String>,
}
fn validate_input(input: &PaneInput) -> Result<(), ApiError> {
    if input.text.len() > 16384 || input.keys.len() > 32 || input.keys.iter().any(|k| k.len() > 64)
    {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({"error":"Input too large"})),
        ));
    }
    Ok(())
}
async fn pane_input(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<PaneInput>,
) -> Result<Json<Value>, ApiError> {
    validate_input(&input)?;
    Ok(Json(
        app.herdr
            .input(&id, &input.text, &input.keys)
            .await
            .map_err(error)?,
    ))
}
async fn herdr_upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(32768)
        .on_upgrade(move |socket| herdr_socket(socket, app.herdr))
}
async fn herdr_socket(mut socket: WebSocket, herdr: herdr::Herdr) {
    let mut tick = interval(Duration::from_millis(300));
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut selected: Option<String> = None;
    let mut previous = String::new();
    let mut previous_snapshot = String::new();
    let mut ticks = 0u32;
    let mut last_pong = std::time::Instant::now();
    loop {
        tokio::select! {
            _=tick.tick()=>{
                if ticks.is_multiple_of(4) {
                    match herdr.snapshot().await {
                        Ok(snapshot)=>{let encoded=snapshot.to_string();if encoded!=previous_snapshot {previous_snapshot=encoded;if !send(&mut socket,json!({"type":"snapshot","snapshot":snapshot})).await{break}}},
                        Err(e)=>{previous_snapshot.clear();if !send(&mut socket,json!({"type":"error","message":e.to_string()})).await{break}},
                    }
                }
                ticks=ticks.wrapping_add(1);
                if let Some(ref pane)=selected {
                    match herdr.read(pane).await {
                        Ok(read)=>{let text=read["text"].as_str().unwrap_or("").to_owned();if text!=previous {previous=text;if !send(&mut socket,json!({"type":"pane","pane_id":pane,"read":read})).await{break}}},
                        Err(e)=>{if !send(&mut socket,json!({"type":"pane_error","pane_id":pane,"message":e.to_string()})).await{break}selected=None;},
                    }
                }
                if ticks.is_multiple_of(50){
                    if last_pong.elapsed()>Duration::from_secs(45){break}
                    if !matches!(timeout(Duration::from_secs(5),socket.send(Message::Ping(Vec::new().into()))).await,Ok(Ok(()))){break}
                }
            },
            event=socket.next()=>match event {
                Some(Ok(Message::Text(text)))=>{
                    if let Ok(v)=serde_json::from_str::<Value>(&text) {match v["type"].as_str(){
                        Some("select")=>{selected=v["pane_id"].as_str().filter(|s|s.len()<128).map(str::to_owned);previous.clear();},
                        Some("input")=>{
                            // Target travels with each key; switching panes never redirects queued input.
                            let result=async {
                                let target=v["pane_id"].as_str().ok_or_else(||error("Missing pane"))?;
                                if selected.as_deref()!=Some(target){return Err(error("Pane changed; input was not sent"))}
                                let input:PaneInput=serde_json::from_value(v.clone()).map_err(error)?;validate_input(&input)?;
                                herdr.input(target,&input.text,&input.keys).await.map_err(error)
                            }.await;
                            match result {Ok(_)=>{if !send(&mut socket,json!({"type":"ack","id":v["id"]})).await{break}},Err((_,Json(e)))=>{if !send(&mut socket,json!({"type":"input_error","id":v["id"],"message":e["error"]})).await{break}}}
                        },_=>{},}}
                },Some(Ok(Message::Pong(_)))=>{last_pong=std::time::Instant::now()},Some(Ok(Message::Ping(bytes)))=>{if socket.send(Message::Pong(bytes)).await.is_err(){break}},_=>break,
            }
        }
    }
}
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let token = std::env::var("OMARCHY_PROXY_TOKEN").expect("OMARCHY_PROXY_TOKEN is required");
    assert!(
        token.len() >= 32,
        "Proxy token must be at least 32 characters"
    );
    let origins = std::env::var("OMARCHY_ORIGINS")
        .unwrap_or_else(|_| {
            "https://your-host.your-tailnet.ts.net:12443,http://127.0.0.1:4187,http://localhost:4187"
                .into()
        })
        .split(',')
        .map(str::to_owned)
        .collect();
    let path = std::env::var_os("OMARCHY_HERDR_SOCKET")
        .map(Into::into)
        .unwrap_or_else(|| {
            std::path::PathBuf::from(std::env::var("HOME").unwrap())
                .join(".config/herdr/herdr.sock")
        });
    let app = App {
        token: Arc::new(token),
        origins: Arc::new(origins),
        sessions: Arc::new(Mutex::new(HashMap::new())),
        herdr: herdr::Herdr { path },
    };
    let router = Router::new()
        .route("/api/capabilities", get(capabilities))
        .route("/api/terminal/session", post(session))
        .route("/api/terminal/{id}/ws", get(terminal_upgrade))
        .route("/api/herdr/snapshot", get(snapshot))
        .route("/api/herdr/panes/{id}", get(pane))
        .route("/api/herdr/panes/{id}/input", post(pane_input))
        .route("/api/herdr/ws", get(herdr_upgrade))
        .layer(DefaultBodyLimit::max(32768))
        .layer(middleware::from_fn_with_state(app.clone(), authorize))
        .with_state(app);
    let port = std::env::var("OMARCHY_API_PORT").unwrap_or_else(|_| "4188".into());
    let listener = tokio::net::TcpListener::bind(format!("127.0.0.1:{port}")).await?;
    println!("Omarchy host backend listening on 127.0.0.1:{port}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let mut signal =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=signal.recv()=>{}}
        })
        .await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_cross_site_and_unauthenticated_browser_requests() {
        let origins = vec!["https://host.example".into()];
        assert!(authorized_browser(&origins, None, false, Some("1")));
        assert!(!authorized_browser(&origins, None, false, None));
        assert!(!authorized_browser(
            &origins,
            Some("https://evil.example"),
            false,
            Some("1")
        ));
        assert!(!authorized_browser(&origins, None, true, None));
        assert!(authorized_browser(
            &origins,
            Some("https://host.example"),
            true,
            None
        ));
    }
}
