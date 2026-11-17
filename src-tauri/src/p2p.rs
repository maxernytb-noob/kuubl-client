//! Peer-to-peer transport for shared worlds. The world runs on the host's PC and the game's bytes go
//! straight between the two PCs over QUIC (UDP) — nothing goes through our VPS except a one-off swap
//! of addresses (`POST /worlds/:id/punch` on Kuubl Social, a few hundred bytes).
//!
//! How two PCs behind routers find each other:
//! - each side opens a fresh UDP socket and learns its candidate addresses: the public one from a STUN
//!   server, a UPnP port mapping on the router if it allows one, and the LAN address (same network);
//! - Kuubl Social hands the guest's candidates to the host and the host's back to the guest;
//! - both sides send packets to each other at the same time (hole punching), so each router sees an
//!   outgoing packet first and lets the answer in. Works on most home networks; fails when both sides
//!   sit behind carrier-grade NAT (mobile data, some school/dorm networks) — then the host can still
//!   give the guest its direct IP if UPnP opened the game port.
//! - The connection is TLS 1.3 (QUIC); the guest pins the host's self-signed certificate by the
//!   SHA-256 fingerprint it got through Kuubl Social, so nobody in between can pretend to be the host.

use anyhow::{anyhow, bail, Context, Result};
use once_cell::sync::Lazy;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::{TcpStream, UdpSocket};

const ALPN: &[u8] = b"justice-p2p/1";
const STUN_SERVERS: &[&str] = &["stun.l.google.com:19302", "stun.cloudflare.com:3478", "stun1.l.google.com:19302"];

static PROVIDER: Lazy<Arc<rustls::crypto::CryptoProvider>> = Lazy::new(|| Arc::new(rustls::crypto::ring::default_provider()));

fn transport() -> Arc<quinn::TransportConfig> {
    let mut t = quinn::TransportConfig::default();
    t.keep_alive_interval(Some(Duration::from_secs(4)));
    t.max_idle_timeout(Some(Duration::from_secs(25).try_into().unwrap()));
    Arc::new(t)
}

// ---------------------------------------------------------------- candidates

/// A UDP socket plus every address the other side might reach it at. Dropping it removes the UPnP
/// mapping (best effort).
pub struct Prepared {
    pub socket: std::net::UdpSocket,
    pub addrs: Vec<String>,
    upnp: Option<(igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, u16)>,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        if let Some((gw, port)) = self.upnp.take() {
            tauri::async_runtime::spawn(async move {
                let _ = gw.remove_port(igd_next::PortMappingProtocol::UDP, port).await;
            });
        }
    }
}

/// The LAN address this PC uses to reach the internet (no packet is sent).
fn lan_ip() -> Option<Ipv4Addr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("1.1.1.1:80").ok()?;
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() => Some(ip),
        _ => None,
    }
}

/// One STUN Binding request (RFC 5389); returns our address as the server sees it.
async fn stun(sock: &UdpSocket, server: &str) -> Option<SocketAddr> {
    let server = tokio::net::lookup_host(server).await.ok()?.find(|a| a.is_ipv4())?;
    let mut req = [0u8; 20];
    req[0..2].copy_from_slice(&0x0001u16.to_be_bytes());
    req[4..8].copy_from_slice(&0x2112A442u32.to_be_bytes());
    let tid: [u8; 12] = rand_bytes();
    req[8..20].copy_from_slice(&tid);
    let mut buf = [0u8; 512];
    for _ in 0..2 {
        sock.send_to(&req, server).await.ok()?;
        let Ok(Ok((n, from))) = tokio::time::timeout(Duration::from_millis(900), sock.recv_from(&mut buf)).await else { continue };
        if from != server || n < 20 || buf[8..20] != tid {
            continue;
        }
        return parse_stun(&buf[..n]);
    }
    None
}

fn parse_stun(b: &[u8]) -> Option<SocketAddr> {
    let mut i = 20;
    while i + 4 <= b.len() {
        let ty = u16::from_be_bytes([b[i], b[i + 1]]);
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        let v = b.get(i + 4..i + 4 + len)?;
        // XOR-MAPPED-ADDRESS (0x0020) or the old MAPPED-ADDRESS (0x0001), IPv4 only.
        if (ty == 0x0020 || ty == 0x0001) && len >= 8 && v[1] == 0x01 {
            let mut port = u16::from_be_bytes([v[2], v[3]]);
            let mut ip = [v[4], v[5], v[6], v[7]];
            if ty == 0x0020 {
                port ^= 0x2112;
                for (k, m) in ip.iter_mut().zip(0x2112A442u32.to_be_bytes()) {
                    *k ^= m;
                }
            }
            return Some(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::from(ip), port)));
        }
        i += 4 + ((len + 3) & !3);
    }
    None
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    let u = uuid::Uuid::new_v4();
    let u2 = uuid::Uuid::new_v4();
    let src: Vec<u8> = u.as_bytes().iter().chain(u2.as_bytes()).copied().collect();
    out.copy_from_slice(&src[..N]);
    out
}

/// Asks the router (UPnP IGD) to forward an outside port to `local`. Returns the gateway, the public
/// address and the outside port.
async fn upnp_map(local: SocketAddrV4, proto: igd_next::PortMappingProtocol) -> Option<(igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, SocketAddr)> {
    let opts = igd_next::SearchOptions { timeout: Some(Duration::from_millis(1500)), ..Default::default() };
    let gw = igd_next::aio::tokio::search_gateway(opts).await.ok()?;
    let ext_ip = gw.get_external_ip().await.ok()?;
    if let IpAddr::V4(v4) = ext_ip {
        if v4.is_private() || v4.is_unspecified() {
            return None; // the router itself is behind another NAT: mapping wouldn't help
        }
    }
    let port = gw.add_any_port(proto, SocketAddr::V4(local), 3600, "Kuubl Client").await.ok()?;
    Some((gw, SocketAddr::new(ext_ip, port)))
}

/// Opens a fresh UDP socket and collects its candidate addresses (STUN, UPnP, LAN) in parallel.
pub async fn prepare() -> Result<Prepared> {
    let sock = UdpSocket::bind("0.0.0.0:0").await.context("UDP")?;
    let port = sock.local_addr()?.port();
    let lan = lan_ip();
    let upnp = async {
        match lan {
            Some(ip) => tokio::time::timeout(Duration::from_secs(3), upnp_map(SocketAddrV4::new(ip, port), igd_next::PortMappingProtocol::UDP)).await.ok().flatten(),
            None => None,
        }
    };
    let stun_all = async {
        let mut found = Vec::new();
        for s in STUN_SERVERS {
            if let Some(a) = stun(&sock, s).await {
                found.push(a);
                if found.len() >= 2 {
                    break;
                }
            }
        }
        found
    };
    let (public, upnp) = tokio::join!(stun_all, upnp);
    let mut addrs: Vec<String> = Vec::new();
    let mut push = |a: SocketAddr| {
        let s = a.to_string();
        if !addrs.contains(&s) {
            addrs.push(s);
        }
    };
    let mut upnp_keep = None;
    if let Some((gw, a)) = upnp {
        push(a);
        upnp_keep = Some((gw, a.port()));
    }
    for a in public {
        push(a);
    }
    if let Some(ip) = lan {
        push(SocketAddr::V4(SocketAddrV4::new(ip, port)));
    }
    ldebug!("p2p: candidates {addrs:?}");
    let socket = sock.into_std()?;
    Ok(Prepared { socket, addrs, upnp: upnp_keep })
}

fn parse_addrs(v: &serde_json::Value) -> Vec<SocketAddr> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str()?.parse().ok()).collect()).unwrap_or_default()
}

// ---------------------------------------------------------------- host

/// Host side of one guest's join: a new QUIC endpoint on a prepared socket, punched towards the
/// guest's addresses. Returns our addresses + certificate fingerprint for the guest; the endpoint
/// accepts one connection and pipes each of its streams to the local LAN world.
pub async fn host_session(guest_addrs: &serde_json::Value, lan_port: u16, label: String) -> Result<(Vec<String>, String)> {
    let prep = prepare().await?;
    let ck = rcgen::generate_simple_self_signed(vec!["justice".to_string()])?;
    let cert_der = rustls::pki_types::CertificateDer::from(ck.cert.der().to_vec());
    let fp = hex::encode(Sha256::digest(cert_der.as_ref()));
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(ck.key_pair.serialize_der().into());
    let mut tls = rustls::ServerConfig::builder_with_provider(PROVIDER.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_no_client_auth()
        .with_single_cert(vec![cert_der], key)?;
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut server = quinn::ServerConfig::with_crypto(Arc::new(quinn::crypto::rustls::QuicServerConfig::try_from(tls)?));
    server.transport_config(transport());

    let socket = prep.socket.try_clone()?;
    let mut endpoint = quinn::Endpoint::new(quinn::EndpointConfig::default(), Some(server), socket, Arc::new(quinn::TokioRuntime))?;
    // Hole punching from our side: QUIC Initial packets to each guest address open our router for the
    // guest's packets. These "connections" are expected to fail; only the outgoing packets matter.
    endpoint.set_default_client_config(punch_client_config()?);
    let targets = parse_addrs(guest_addrs);
    let addrs = prep.addrs.clone();
    {
        let ep = endpoint.clone();
        tauri::async_runtime::spawn(async move {
            for wait in [0u64, 300, 700, 1500, 3000] {
                tokio::time::sleep(Duration::from_millis(wait)).await;
                for t in &targets {
                    if let Ok(c) = ep.connect(*t, "punch") {
                        tauri::async_runtime::spawn(async move {
                            let _ = tokio::time::timeout(Duration::from_secs(2), c).await;
                        });
                    }
                }
            }
        });
    }
    tauri::async_runtime::spawn(async move {
        let _keep = prep; // the UPnP mapping lives as long as this session
        let accepted = tokio::time::timeout(Duration::from_secs(20), endpoint.accept()).await;
        let Ok(Some(incoming)) = accepted else {
            lwarn!("p2p: {label} never reached us");
            return;
        };
        // One guest per endpoint: refuse anyone else who finds this port.
        endpoint.set_server_config(None);
        let conn = match incoming.await {
            Ok(c) => c,
            Err(e) => {
                lwarn!("p2p: handshake with {label} failed: {e}");
                return;
            }
        };
        linfo!("p2p: {label} connected directly from {}", conn.remote_address());
        loop {
            match conn.accept_bi().await {
                Ok((send, recv)) => {
                    tauri::async_runtime::spawn(async move {
                        match TcpStream::connect(("127.0.0.1", lan_port)).await {
                            Ok(tcp) => pipe(tcp, send, recv).await,
                            Err(e) => lwarn!("p2p: local world refused the connection: {e}"),
                        }
                    });
                }
                Err(_) => break,
            }
        }
        linfo!("p2p: {label} left");
        endpoint.wait_idle().await;
    });
    Ok((addrs, fp))
}

fn punch_client_config() -> Result<quinn::ClientConfig> {
    client_config(String::new())
}

// ---------------------------------------------------------------- guest

/// Accepts exactly the certificate whose SHA-256 the host sent us through Kuubl Social.
#[derive(Debug)]
struct Pinned {
    fp: String,
}

impl rustls::client::danger::ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if !self.fp.is_empty() && hex::encode(Sha256::digest(end_entity.as_ref())) == self.fp {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate doesn't match the host".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        _m: &[u8],
        _c: &rustls::pki_types::CertificateDer<'_>,
        _d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 not used".into()))
    }

    fn verify_tls13_signature(
        &self,
        m: &[u8],
        c: &rustls::pki_types::CertificateDer<'_>,
        d: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &PROVIDER.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        PROVIDER.signature_verification_algorithms.supported_schemes()
    }
}

fn client_config(fp: String) -> Result<quinn::ClientConfig> {
    let mut tls = rustls::ClientConfig::builder_with_provider(PROVIDER.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { fp }))
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut c = quinn::ClientConfig::new(Arc::new(quinn::crypto::rustls::QuicClientConfig::try_from(tls)?));
    c.transport_config(transport());
    Ok(c)
}

/// Guest side: swaps addresses through Kuubl Social and races a direct connection to every host
/// address. The returned connection carries one stream per Minecraft TCP connection.
pub async fn connect(world: &str) -> Result<(quinn::Endpoint, quinn::Connection)> {
    let prep = prepare().await?;
    if prep.addrs.is_empty() {
        bail!(l!("Nepodařilo se zjistit tvou adresu na internetu (je PC připojené?)", "Couldn't find your internet address (is the PC online?)"));
    }
    let answer = crate::social::post(&format!("/worlds/{world}/punch"), serde_json::json!({ "addrs": prep.addrs })).await?;
    connect_with(prep, &answer).await
}

async fn connect_with(prep: Prepared, answer: &serde_json::Value) -> Result<(quinn::Endpoint, quinn::Connection)> {
    if let Some(e) = answer["error"].as_str() {
        bail!("{e}");
    }
    let fp = answer["cert"].as_str().unwrap_or_default().to_string();
    let targets = parse_addrs(&answer["addrs"]);
    if targets.is_empty() || fp.is_empty() {
        bail!(l!("Hostitel neposlal svou adresu", "The host didn't send its address"));
    }
    let socket = prep.socket.try_clone()?;
    let mut endpoint = quinn::Endpoint::new(quinn::EndpointConfig::default(), None, socket, Arc::new(quinn::TokioRuntime))?;
    endpoint.set_default_client_config(client_config(fp)?);
    // Try every address a few times; the first finished handshake wins.
    let attempt = async {
        let mut tries = Vec::new();
        for round in 0..3u64 {
            for t in &targets {
                let ep = endpoint.clone();
                let t = *t;
                tries.push(Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(round * 900)).await;
                    let c = ep.connect(t, "justice").map_err(|e| anyhow!(e))?;
                    c.await.map_err(|e| anyhow!(e))
                }));
            }
        }
        futures::future::select_ok(tries).await.map(|(c, _)| c)
    };
    let conn = tokio::time::timeout(Duration::from_secs(9), attempt)
        .await
        .map_err(|_| anyhow!(NO_ROUTE))?
        .map_err(|_| anyhow!(NO_ROUTE))?;
    linfo!("p2p: connected directly to {}", conn.remote_address());
    // Keep the UPnP mapping (if any) for as long as the endpoint lives.
    tauri::async_runtime::spawn({
        let ep = endpoint.clone();
        async move {
            let _keep = prep;
            ep.wait_idle().await;
        }
    });
    Ok((endpoint, conn))
}

const NO_ROUTE: &str = "Direct connection failed: one of you is probably behind a shared connection (mobile data, CGNAT, school network). Ask the host for the direct IP from the Host window.";

/// Minecraft TCP <-> one QUIC stream until either side closes.
pub async fn pipe(tcp: TcpStream, mut send: quinn::SendStream, mut recv: quinn::RecvStream) {
    let _ = tcp.set_nodelay(true);
    let (mut tr, mut tw) = tcp.into_split();
    let up = async {
        let _ = tokio::io::copy(&mut tr, &mut send).await;
        let _ = send.finish();
    };
    let down = async {
        let _ = tokio::io::copy(&mut recv, &mut tw).await;
        let _ = tokio::io::AsyncWriteExt::shutdown(&mut tw).await;
    };
    tokio::join!(up, down);
}

/// Host: tries to forward the Minecraft LAN port on the router so guests can also join by plain IP
/// (the fallback when hole punching fails). Returns "ip:port" and keeps the mapping in `DIRECT`.
pub async fn open_direct(lan_port: u16) -> Option<String> {
    let ip = lan_ip()?;
    let (gw, addr) = tokio::time::timeout(Duration::from_secs(4), upnp_map(SocketAddrV4::new(ip, lan_port), igd_next::PortMappingProtocol::TCP)).await.ok()??;
    *DIRECT.lock().unwrap() = Some((gw, addr.port()));
    Some(addr.to_string())
}

static DIRECT: Lazy<std::sync::Mutex<Option<(igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, u16)>>> = Lazy::new(Default::default);

pub fn close_direct() {
    if let Some((gw, port)) = DIRECT.lock().unwrap().take() {
        tauri::async_runtime::spawn(async move {
            let _ = gw.remove_port(igd_next::PortMappingProtocol::TCP, port).await;
        });
    }
}

/// `--p2p-selftest`: a fake world (TCP echo) hosted through `host_session` and joined through
/// `connect_with` on this PC — STUN, UPnP, punching, TLS pinning and streams, without Kuubl Social.
pub async fn selftest() -> Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let echo_port = echo.local_addr()?.port();
    tauri::async_runtime::spawn(async move {
        while let Ok((mut s, _)) = echo.accept().await {
            tauri::async_runtime::spawn(async move {
                let mut b = [0u8; 4096];
                while let Ok(n) = s.read(&mut b).await {
                    if n == 0 || s.write_all(&b[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    let t0 = std::time::Instant::now();
    let guest = prepare().await?;
    println!("guest candidates: {:?} ({} ms)", guest.addrs, t0.elapsed().as_millis());
    let (host_addrs, fp) = host_session(&serde_json::json!(guest.addrs), echo_port, "selftest".into()).await?;
    println!("host candidates:  {host_addrs:?}");
    let answer = serde_json::json!({ "addrs": host_addrs, "cert": fp });
    let (ep, conn) = connect_with(guest, &answer).await?;
    println!("connected to {} ({} ms)", conn.remote_address(), t0.elapsed().as_millis());
    let (mut send, mut recv) = conn.open_bi().await?;
    let msg = vec![7u8; 100_000];
    send.write_all(&msg).await?;
    let mut back = vec![0u8; msg.len()];
    recv.read_exact(&mut back).await?;
    if back != msg {
        bail!("echo mismatch");
    }
    println!("100 kB round trip OK, rtt {:?}", conn.rtt());
    // A wrong fingerprint must be refused.
    let guest2 = prepare().await?;
    let (host2, _) = host_session(&serde_json::json!(guest2.addrs), echo_port, "selftest-bad".into()).await?;
    let bad = connect_with(guest2, &serde_json::json!({ "addrs": host2, "cert": "00".repeat(32) })).await;
    println!("wrong certificate refused: {}", bad.is_err());
    conn.close(0u32.into(), b"done");
    ep.wait_idle().await;
    Ok(())
}
