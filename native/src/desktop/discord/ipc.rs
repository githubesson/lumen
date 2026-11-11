//! Discord's local RPC over IPC, what `discord-rpc`'s IPC transport does: a
//! named pipe `\\?\pipe\discord-ipc-N` on Windows, a unix socket
//! `$XDG_RUNTIME_DIR/discord-ipc-N` elsewhere, N from 0 to 9. Frames are a
//! little-endian opcode and length, then JSON.

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{Connector, Rpc, RpcError};

const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
const CLOSE: u32 = 2;
const PING: u32 = 3;
const PONG: u32 = 4;

/// How long Discord gets to answer the handshake or a request.
const ANSWER: Duration = Duration::from_secs(10);

/// A frame longer than this isn't Discord's.
const MAX_FRAME: usize = 1 << 20;

#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;
#[cfg(windows)]
type Stream = std::fs::File;

/// The places Discord listens, in the order `discord-rpc` tries them (plus
/// the Flatpak and Snap sandboxes on Linux).
fn candidates(id: u8) -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    {
        vec![format!(r"\\?\pipe\discord-ipc-{id}").into()]
    }
    #[cfg(unix)]
    {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let runtime = var("XDG_RUNTIME_DIR");
        let base = runtime.clone().or_else(|| var("TMPDIR")).or_else(|| var("TMP")).or_else(|| var("TEMP")).unwrap_or_else(|| "/tmp".into());
        let base = base.trim_end_matches('/').to_string();
        let mut paths = vec![format!("{base}/discord-ipc-{id}").into()];
        if let Some(run) = runtime {
            for sandbox in ["app/com.discordapp.Discord", "app/com.discordapp.DiscordCanary", "app/com.discordapp.DiscordPTB", "app/dev.vencord.Vesktop", "app/xyz.armcord.ArmCord", "snap.discord", "snap.discord-canary"] {
                paths.push(format!("{run}/{sandbox}/discord-ipc-{id}").into());
            }
        }
        paths
    }
}

fn open() -> Option<Stream> {
    for id in 0..10 {
        for path in candidates(id) {
            #[cfg(unix)]
            let stream = Stream::connect(&path);
            #[cfg(windows)]
            let stream = std::fs::OpenOptions::new().read(true).write(true).open(&path);
            if let Ok(stream) = stream {
                return Some(stream);
            }
        }
    }
    None
}

/// Bytes waiting to be read without blocking, or an error once the pipe is gone.
#[cfg(windows)]
fn available(stream: &Stream) -> std::io::Result<usize> {
    use std::os::windows::io::AsRawHandle;
    let mut avail = 0u32;
    // SAFETY: a live pipe handle; only the count is written.
    let ok = unsafe {
        windows_sys::Win32::System::Pipes::PeekNamedPipe(
            stream.as_raw_handle() as _,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut avail,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 { Err(std::io::Error::last_os_error()) } else { Ok(avail as usize) }
}

pub struct Conn {
    stream: Stream,
    buf: Vec<u8>,
    nonce: u64,
}

impl Conn {
    fn write_frame(&mut self, op: u32, payload: &Value) -> std::io::Result<()> {
        let body = payload.to_string().into_bytes();
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&op.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        self.stream.write_all(&frame)?;
        self.stream.flush()
    }

    /// Reads whatever arrives within `wait` into the buffer: Ok(false) when
    /// nothing did, Err once the connection is gone. A synchronous pipe
    /// handle can't time a read out, so Windows peeks first; a pipe read
    /// would also block writes on the same handle.
    fn fill(&mut self, wait: Duration) -> std::io::Result<bool> {
        let mut chunk = [0u8; 16 * 1024];
        #[cfg(windows)]
        {
            let deadline = Instant::now() + wait;
            loop {
                let n = available(&self.stream)?;
                if n > 0 {
                    let len = n.min(chunk.len());
                    let read = self.stream.read(&mut chunk[..len])?;
                    if read == 0 {
                        return Err(std::io::ErrorKind::UnexpectedEof.into());
                    }
                    self.buf.extend_from_slice(&chunk[..read]);
                    return Ok(true);
                }
                if Instant::now() >= deadline {
                    return Ok(false);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(unix)]
        {
            self.stream.set_read_timeout(Some(wait.max(Duration::from_millis(1))))?;
            match self.stream.read(&mut chunk) {
                Ok(0) => Err(std::io::ErrorKind::UnexpectedEof.into()),
                Ok(n) => {
                    self.buf.extend_from_slice(&chunk[..n]);
                    Ok(true)
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(false),
                Err(e) => Err(e),
            }
        }
    }

    /// The next whole frame, waiting until `deadline`; None when none came.
    fn read_frame(&mut self, deadline: Instant) -> Result<Option<(u32, Value)>, RpcError> {
        loop {
            if self.buf.len() >= 8 {
                let op = u32::from_le_bytes(self.buf[0..4].try_into().expect("4 bytes"));
                let len = u32::from_le_bytes(self.buf[4..8].try_into().expect("4 bytes")) as usize;
                if len > MAX_FRAME {
                    return Err(RpcError::Closed("Discord sent a frame that's too long".into()));
                }
                if self.buf.len() >= 8 + len {
                    let body: Vec<u8> = self.buf.drain(..8 + len).skip(8).collect();
                    let value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                    return Ok(Some((op, value)));
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(None);
            }
            match self.fill(deadline - now) {
                Ok(_) => {}
                Err(e) => return Err(RpcError::Closed(format!("connection closed: {e}"))),
            }
        }
    }

    /// Handles a frame that isn't the answer being waited for; Err when it
    /// closes the connection.
    fn other(&mut self, op: u32, value: Value) -> Result<(), RpcError> {
        match op {
            PING => self.write_frame(PONG, &value).map_err(|e| RpcError::Closed(e.to_string())),
            CLOSE => Err(RpcError::Closed(value["message"].as_str().unwrap_or("connection closed").to_string())),
            _ => Ok(()),
        }
    }

    fn handshake(&mut self, client_id: &str) -> Result<(), String> {
        self.write_frame(HANDSHAKE, &json!({ "v": 1, "client_id": client_id })).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + ANSWER;
        loop {
            match self.read_frame(deadline).map_err(|e| e.to_string())? {
                None => return Err("Discord didn't answer the handshake".into()),
                Some((FRAME, value)) if value["cmd"] == "DISPATCH" && value["evt"] == "READY" => return Ok(()),
                Some((FRAME, value)) if value["evt"] == "ERROR" => {
                    return Err(value["data"]["message"].as_str().unwrap_or("Discord refused the connection").to_string());
                }
                Some((op, value)) => self.other(op, value).map_err(|e| e.to_string())?,
            }
        }
    }

    fn request(&mut self, cmd: &str, args: Value) -> Result<Value, RpcError> {
        self.nonce += 1;
        let nonce = format!("{}-{}", std::process::id(), self.nonce);
        self.write_frame(FRAME, &json!({ "cmd": cmd, "args": args, "nonce": nonce }))
            .map_err(|e| RpcError::Closed(e.to_string()))?;
        let deadline = Instant::now() + ANSWER;
        loop {
            match self.read_frame(deadline)? {
                None => return Err(RpcError::Closed("Discord didn't answer".into())),
                Some((FRAME, value)) if value["nonce"] == nonce.as_str() => {
                    if value["evt"] == "ERROR" {
                        return Err(RpcError::Failed(value["data"]["message"].as_str().unwrap_or("Discord refused the update").to_string()));
                    }
                    return Ok(value["data"].clone());
                }
                Some((op, value)) => self.other(op, value)?,
            }
        }
    }
}

impl Rpc for Conn {
    fn set_activity(&mut self, pid: u32, activity: Option<Value>) -> Result<(), RpcError> {
        let clearing = activity.is_none();
        let args = match activity {
            Some(activity) => json!({ "pid": pid, "activity": activity }),
            None => json!({ "pid": pid }),
        };
        let result = self.request("SET_ACTIVITY", args).map(|_| ());
        if std::env::var_os("LUMEN_DISCORD_TRACE").is_some() {
            eprintln!("[discord] {} {}", if clearing { "clear" } else { "activity" }, if result.is_ok() { "accepted" } else { "failed" });
        }
        result
    }

    fn poll(&mut self) -> Result<(), RpcError> {
        // Whatever has arrived, then the frames in it: a CLOSE before the
        // pipe ends says why.
        let gone = loop {
            match self.fill(Duration::from_millis(1)) {
                Ok(true) => continue,
                Ok(false) => break None,
                Err(e) => break Some(e),
            }
        };
        while let Some((op, value)) = self.read_frame(Instant::now())? {
            self.other(op, value)?;
        }
        match gone {
            Some(e) => Err(RpcError::Closed(format!("connection closed: {e}"))),
            None => Ok(()),
        }
    }

    fn close(&mut self) {
        let _ = self.write_frame(CLOSE, &json!({}));
        #[cfg(unix)]
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Connects to the Discord client running on this machine.
pub struct IpcConnector;

fn allow_live_rpc(headless: bool, args: impl IntoIterator<Item = String>, opt_in: bool) -> bool {
    opt_in || (!headless && !args.into_iter().any(|arg| arg == "--scene" || arg.starts_with("--scene=")))
}

impl Connector for IpcConnector {
    fn connect(&mut self, client_id: &str) -> Result<Box<dyn Rpc>, String> {
        // Fixture windows share the desktop's IPC socket unless explicitly
        // isolated. Never let their fake songs replace the user's activity.
        // Deliberate integration checks can opt in with an isolated account.
        if !allow_live_rpc(rune::is_headless(), std::env::args(), std::env::var("LUMEN_TEST_DISCORD").as_deref() == Ok("1")) {
            return Err("Discord disabled for test scenes (LUMEN_TEST_DISCORD=1 to opt in)".into());
        }
        let stream = open().ok_or("Could not connect")?;
        let mut conn = Conn { stream, buf: Vec::new(), nonce: 0 };
        conn.handshake(client_id)?;
        Ok(Box::new(conn))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    #[test]
    fn test_runs_cannot_publish_live_activity_without_opt_in() {
        let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(allow_live_rpc(false, args(&["lumen"]), false));
        assert!(!allow_live_rpc(true, args(&["lumen"]), false));
        assert!(!allow_live_rpc(false, args(&["lumen", "--scene", "library"]), false));
        assert!(!allow_live_rpc(false, args(&["lumen", "--scene=library"]), false));
        assert!(allow_live_rpc(true, args(&["lumen", "--scene", "library"]), true));
    }

    fn read_frame(s: &mut UnixStream) -> (u32, Value) {
        let mut head = [0u8; 8];
        s.read_exact(&mut head).unwrap();
        let op = u32::from_le_bytes(head[0..4].try_into().unwrap());
        let mut body = vec![0; u32::from_le_bytes(head[4..8].try_into().unwrap()) as usize];
        s.read_exact(&mut body).unwrap();
        (op, serde_json::from_slice(&body).unwrap())
    }

    fn write_frame(s: &mut UnixStream, op: u32, v: Value) {
        let body = v.to_string();
        s.write_all(&op.to_le_bytes()).unwrap();
        s.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
        s.write_all(body.as_bytes()).unwrap();
    }

    /// A Discord stand-in: the handshake, a ping, then one SET_ACTIVITY answered.
    #[test]
    fn speaks_discords_ipc() {
        let (client, mut discord) = UnixStream::pair().unwrap();
        let server = std::thread::spawn(move || {
            let (op, hello) = read_frame(&mut discord);
            assert_eq!((op, hello), (HANDSHAKE, json!({ "v": 1, "client_id": "fixture" })));
            write_frame(&mut discord, FRAME, json!({ "cmd": "DISPATCH", "evt": "READY", "data": { "v": 1 } }));
            let (op, request) = read_frame(&mut discord);
            assert_eq!(op, FRAME);
            assert_eq!(request["cmd"], "SET_ACTIVITY");
            assert_eq!(request["args"]["activity"]["details"], "Song");
            write_frame(&mut discord, PING, json!({ "n": 1 }));
            assert_eq!(read_frame(&mut discord), (PONG, json!({ "n": 1 })));
            write_frame(&mut discord, FRAME, json!({ "cmd": "SET_ACTIVITY", "evt": null, "nonce": request["nonce"], "data": {} }));
            let (_, clear) = read_frame(&mut discord);
            assert_eq!(clear["args"].get("activity"), None);
            write_frame(&mut discord, FRAME, json!({ "evt": "ERROR", "nonce": clear["nonce"], "data": { "code": 4000, "message": "nope" } }));
            write_frame(&mut discord, CLOSE, json!({ "code": 1000, "message": "bye" }));
        });
        let mut conn = Conn { stream: client, buf: Vec::new(), nonce: 0 };
        conn.handshake("fixture").unwrap();
        conn.set_activity(1, Some(json!({ "details": "Song" }))).unwrap();
        assert_eq!(conn.set_activity(1, None), Err(RpcError::Failed("nope".into())));
        server.join().unwrap();
        assert_eq!(conn.poll(), Err(RpcError::Closed("bye".into())));
    }

    #[test]
    fn answers_pings_and_notices_discord_leaving_between_updates() {
        let (client, mut discord) = UnixStream::pair().unwrap();
        let mut conn = Conn { stream: client, buf: Vec::new(), nonce: 0 };
        assert_eq!(conn.poll(), Ok(()));
        write_frame(&mut discord, PING, json!({ "n": 2 }));
        assert_eq!(conn.poll(), Ok(()));
        assert_eq!(read_frame(&mut discord), (PONG, json!({ "n": 2 })));
        drop(discord);
        assert!(matches!(conn.poll(), Err(RpcError::Closed(_))));
    }

    #[test]
    fn finds_discord_in_the_runtime_dir() {
        let paths = candidates(3);
        assert!(paths[0].to_string_lossy().ends_with("/discord-ipc-3"));
    }
}
