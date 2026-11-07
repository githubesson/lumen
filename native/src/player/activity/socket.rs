//! The playback session's socket: a thread that keeps a websocket to
//! `/api/activity/ws` open (reconnecting with backoff, as the web client
//! does), sends what the session queues and hands back what arrives.

use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crate::net::LateWaker;

pub(super) enum Out {
    Send(String),
    Close,
}

#[derive(Debug)]
pub enum SocketEvent {
    Open,
    Closed,
    Message(String),
}

pub(super) struct SocketHandle {
    pub out: Sender<Out>,
    pub stop: Arc<AtomicBool>,
}

impl Drop for SocketHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// `ws(s)://host/api/activity/ws?device_id=…` for the server at `base`.
pub fn socket_url(base: &str, device_id: &str) -> Option<String> {
    let (scheme, rest) = base.split_once("://")?;
    let ws = match scheme.to_ascii_lowercase().as_str() {
        "https" => "wss",
        "http" => "ws",
        _ => return None,
    };
    let host = rest.split('/').next()?;
    Some(format!("{ws}://{host}/api/activity/ws?device_id={}", urlencoding::encode(device_id)))
}

/// A TCP or TLS stream whose read timeouts read as "would block", so the
/// socket loop can interleave its writes.
enum Stream {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Stream {
    fn tcp(&self) -> &TcpStream {
        match self {
            Stream::Plain(s) => s,
            Stream::Tls(s) => &s.sock,
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let r = match self {
            Stream::Plain(s) => s.read(buf),
            Stream::Tls(s) => s.read(buf),
        };
        r.map_err(|e| if e.kind() == io::ErrorKind::TimedOut { io::ErrorKind::WouldBlock.into() } else { e })
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.write(buf),
            Stream::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Stream::Plain(s) => s.flush(),
            Stream::Tls(s) => s.flush(),
        }
    }
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("TLS versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

type Socket = tungstenite::WebSocket<Stream>;

fn connect(url: &str, cookie: Option<&str>) -> Result<Socket, String> {
    use tungstenite::client::IntoClientRequest;
    let (scheme, rest) = url.split_once("://").ok_or("bad url")?;
    let authority = rest.split('/').next().unwrap_or(rest);
    let tls = scheme == "wss";
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.ends_with(']') || authority.starts_with('[') => (h.to_string(), p.parse().map_err(|_| "bad port")?),
        _ => (authority.to_string(), if tls { 443 } else { 80 }),
    };
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let addr = (host.as_str(), port).to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10)).map_err(|e| e.to_string())?;
    tcp.set_read_timeout(Some(Duration::from_secs(15))).map_err(|e| e.to_string())?;
    tcp.set_nodelay(true).ok();
    let stream = if tls {
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| e.to_string())?;
        let conn = rustls::ClientConnection::new(tls_config(), name).map_err(|e| e.to_string())?;
        Stream::Tls(Box::new(rustls::StreamOwned::new(conn, tcp)))
    } else {
        Stream::Plain(tcp)
    };
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    if let Some(cookie) = cookie.and_then(|c| c.parse().ok()) {
        headers.insert("Cookie", cookie);
    }
    if let Ok(ua) = crate::net::USER_AGENT.parse() {
        headers.insert("User-Agent", ua);
    }
    let mut attempt = tungstenite::client::client(request, stream);
    let started = Instant::now();
    let socket = loop {
        match attempt {
            Ok((socket, _)) => break socket,
            Err(tungstenite::HandshakeError::Interrupted(mid)) if started.elapsed() < Duration::from_secs(15) => attempt = mid.handshake(),
            Err(e) => return Err(e.to_string()),
        }
    };
    socket.get_ref().tcp().set_read_timeout(Some(Duration::from_millis(50))).map_err(|e| e.to_string())?;
    Ok(socket)
}

const RECONNECT_BASE_MS: f64 = 500.0;
const RECONNECT_MAX_MS: f64 = 15_000.0;

pub(super) fn run_socket(url: String, cookie: Option<String>, out: Receiver<Out>, events: Sender<SocketEvent>, waker: LateWaker, stop: Arc<AtomicBool>) {
    let notify = |e: SocketEvent| {
        let _ = events.send(e);
        waker.wake();
    };
    let mut attempt = 0i32;
    while !stop.load(Ordering::Relaxed) {
        if let Ok(mut socket) = connect(&url, cookie.as_deref()) {
            attempt = 0;
            notify(SocketEvent::Open);
            'live: loop {
                if stop.load(Ordering::Relaxed) {
                    let _ = socket.close(None);
                    let _ = socket.flush();
                    break 'live;
                }
                loop {
                    match out.try_recv() {
                        Ok(Out::Send(text)) => {
                            if socket.send(tungstenite::Message::text(text)).is_err() {
                                break 'live;
                            }
                        }
                        Ok(Out::Close) | Err(TryRecvError::Disconnected) => {
                            let _ = socket.close(None);
                            let _ = socket.flush();
                            notify(SocketEvent::Closed);
                            return;
                        }
                        Err(TryRecvError::Empty) => break,
                    }
                }
                match socket.read() {
                    Ok(tungstenite::Message::Text(text)) => notify(SocketEvent::Message(text.to_string())),
                    Ok(tungstenite::Message::Close(_)) => break 'live,
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if e.kind() == io::ErrorKind::WouldBlock => {
                        // Answer pings and send what's queued.
                        if socket.flush().is_err() {
                            break 'live;
                        }
                    }
                    Err(_) => break 'live,
                }
            }
            notify(SocketEvent::Closed);
        }
        if stop.load(Ordering::Relaxed) {
            return;
        }
        // Back off, with jitter; what's sent meanwhile is dropped (REST covers it).
        let delay = RECONNECT_MAX_MS.min(RECONNECT_BASE_MS * 2f64.powi(attempt.min(10))) * (0.75 + fastrand::f64() * 0.5);
        attempt += 1;
        let until = Instant::now() + Duration::from_millis(delay as u64);
        while Instant::now() < until {
            if stop.load(Ordering::Relaxed) {
                return;
            }
            match out.try_recv() {
                Ok(Out::Close) | Err(TryRecvError::Disconnected) => return,
                _ => {}
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
