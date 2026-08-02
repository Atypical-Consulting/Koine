// Koine Studio — real-time collaboration session broker (#481 Task 5).
//
// This module is the desktop half of the collaboration capability ADR 0013 settled: CRDT replicas
// over a host-brokered, OPAQUE transport. It carries update bytes and presence frames between
// participants and understands neither `.koi` nor Yjs — merge logic lives entirely in the client
// (`src/editor/collab/crdtBinding.ts`).
//
// The behavioural contract is not invented here: `src/host/collabTransport.ts`'s
// `createInMemoryCollabBroker()` is the executable spec this must match, and the TypeScript suites
// pinned against it (`src/host/collab.test.ts`, `src/editor/collab/session.test.ts`) are what a
// divergence would break.
//
// TRUST MODEL — this is network-facing code, so state it plainly:
//
//   0. **Every connection is encrypted, before a byte of protocol is read.** One Noise handshake
//      (`Noise_NK_25519_ChaChaPoly_BLAKE2s`, see `noise.rs`) per connection, with the broker's static
//      public key pinned by the dialler from the join token. There is no plaintext code path and no
//      negotiation, so there is nothing to downgrade and nothing for a user to remember (#1811,
//      ADR 0017). What that buys and what it does NOT — peers are authenticated only by the bearer
//      token, and a relay terminates the encryption — is ADR 0017's threat model.
//
//   1. **Authority is a property of the CONNECTION, never of a claimed identity.** A session's
//      authority is the `MemberId` the broker minted for the creating connection. `join` can never
//      return `authority: true`, whatever identity it presents — a joiner echoing the creator's
//      participant id would otherwise get a second document authority, and two participants each
//      believing they own the canonical save is a lost-write bug.
//   2. **A participant can only ever speak AS the identity it was admitted under.** Every outbound
//      presence frame is re-stamped from the sender's admitted identity, so a peer holding the token
//      cannot paint a caret labelled as someone else. Joining with an identity id already present in
//      the session is refused outright, which is what makes that stamping unambiguous.
//   3. **The join token is a bearer credential.** It is the ONLY thing standing between a stranger
//      and edit access to someone's domain model, so it is 128 CSPRNG bits, compared in constant
//      time, and never echoed into an error message or a log line.
//   4. **Everything off the wire is hostile until validated** — frame length, identity fields,
//      presence extents and member counts are all bounded before anything is allocated or stored.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[cfg(test)]
use crate::noise::PUBLIC_KEY_HEX_LEN;
use crate::noise::{
    decode_public_key, encode_hex, handshake_initiator, handshake_responder, split, NoiseReader,
    NoiseWriter, StaticKeypair, PUBLIC_KEY_BYTES,
};

// --- limits (every one of these bounds something an unauthenticated peer controls) --------------

/// Largest accepted wire frame. A `.koi` model is kilobytes and a Yjs update smaller still; the
/// ceiling exists so a peer cannot make the broker allocate arbitrarily by declaring a huge length.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
/// Participants in one session. A modelling workshop is a handful of people, not a stadium.
pub const MAX_MEMBERS_PER_SESSION: usize = 16;
/// Concurrent sessions one broker will host.
pub const MAX_SESSIONS: usize = 8;
/// Bound on every free-text identity field, so a peer cannot store megabytes in the member table.
pub const MAX_IDENTITY_FIELD_LEN: usize = 64;
/// Bound on a presence frame's selection ranges.
pub const MAX_SELECTION_RANGES: usize = 64;
/// Length of the hex-encoded session secret (32 hex chars = 128 bits).
pub const SECRET_HEX_LEN: usize = 32;
/// Scheme prefix of a join token: `koine-collab://<host>:<port>/<secret>/<public-key>`.
pub const TOKEN_SCHEME: &str = "koine-collab://";

/// Broker-minted handle for one connection. NOT the client's participant id — see the trust model.
pub type MemberId = u64;

// --- wire types (mirror `CollabParticipant` / `CollabPresence` in src/host/types.ts) ------------

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub id: String,
    pub display_name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub from: u32,
    pub to: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub participant_id: String,
    pub display_name: String,
    pub color: String,
    pub cursor: u32,
    pub selection: Vec<Range>,
}

/// Frames a participant sends to the broker.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientFrame {
    /// The first frame on every connection; anything else before it is a protocol error.
    Join {
        secret: String,
        identity: Participant,
    },
    /// Open a session on the broker itself. Honoured by a RELAY only — a hosted session refuses it,
    /// so reaching someone's desktop listener never lets you open a session on their machine.
    Create {
        identity: Participant,
    },
    Update {
        update: Vec<u8>,
    },
    Presence {
        presence: Presence,
    },
    Leave,
}

/// Frames the broker sends to a participant.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerFrame {
    Admitted {
        session_id: String,
        /// Straight from the broker and never inferred client-side — see trust model rule 1.
        authority: bool,
        /// The identity this participant was admitted under; every frame it sends is stamped with it.
        #[serde(rename = "self")]
        admitted_as: Participant,
        /// The session secret, returned ONLY to the participant that opened the session on a relay
        /// (it is the credential it must hand to the people it is inviting). `None` for a joiner,
        /// who already holds it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret: Option<String>,
    },
    Rejected {
        reason: String,
    },
    Update {
        update: Vec<u8>,
    },
    Presence {
        presence: Presence,
    },
    PeerJoin {
        peer: Participant,
    },
    PeerLeave {
        participant_id: String,
    },
}

/// One frame addressed to one member. The broker is pure: it decides *what goes where* and the
/// caller (the socket/IPC layer) performs the I/O, which is what keeps every rule here unit-testable.
pub type Delivery = (MemberId, ServerFrame);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrokerError {
    UnknownSession,
    SessionFull,
    TooManySessions,
    SecretInUse,
    DuplicateIdentity,
    InvalidIdentity,
}

impl BrokerError {
    /// Human-readable, and deliberately free of anything a caller supplied — an error is the one
    /// place a secret leaks by accident.
    pub fn message(self) -> &'static str {
        match self {
            BrokerError::UnknownSession => "unknown or expired collaboration session token",
            BrokerError::SessionFull => "this collaboration session is full",
            BrokerError::TooManySessions => "too many collaboration sessions on this host",
            BrokerError::SecretInUse => "a collaboration session is already open with that token",
            BrokerError::DuplicateIdentity => {
                "a participant with that identity is already in the session"
            }
            BrokerError::InvalidIdentity => "invalid participant identity",
        }
    }
}

/// The outcome of a successful `create`/`join`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub member: MemberId,
    pub session_id: String,
    pub authority: bool,
    pub admitted_as: Participant,
    /// Peer replay for the joiner, then the joiner's announcement to the incumbents — in that order.
    pub deliveries: Vec<Delivery>,
}

/// The outcome of a member leaving (or its connection dropping).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Departure {
    pub deliveries: Vec<Delivery>,
    /// True when the session is gone — the authority left, or that was the last member. The socket
    /// layer closes every remaining connection when it sees this.
    pub session_closed: bool,
    /// Members still connected to the (now closed) session, so the caller can hang up on them.
    pub remaining: Vec<MemberId>,
}

#[derive(Debug, Clone)]
struct Member {
    id: MemberId,
    identity: Participant,
}

#[derive(Debug)]
struct Session {
    id: String,
    secret: String,
    /// The MEMBER handle of the creating connection — deliberately not its participant id, which is
    /// self-asserted and therefore forgeable by anyone holding the token (trust model rule 1).
    authority: MemberId,
    members: Vec<Member>,
}

/// A session registry with sender-excluded fan-out. Pure: no sockets, no Tauri, no clock.
#[derive(Debug, Default)]
pub struct Broker {
    sessions: Vec<Session>,
    next_member: MemberId,
    next_session: u64,
}

// --- implementation ----------------------------------------------------------------------------

impl Broker {
    pub fn new() -> Self {
        Broker {
            sessions: Vec::new(),
            next_member: 0,
            next_session: 0,
        }
    }

    /// Open a session. The creating connection becomes — and stays — the document authority.
    pub fn create(
        &mut self,
        identity: Participant,
        secret: String,
    ) -> Result<Admission, BrokerError> {
        validate_identity(&identity)?;
        if self.sessions.len() >= MAX_SESSIONS {
            return Err(BrokerError::TooManySessions);
        }
        if self.find_session(&secret).is_some() {
            return Err(BrokerError::SecretInUse);
        }

        let member = self.mint_member();
        self.next_session += 1;
        let session_id = format!("s{}", self.next_session);
        self.sessions.push(Session {
            id: session_id.clone(),
            secret,
            authority: member,
            members: vec![Member {
                id: member,
                identity: identity.clone(),
            }],
        });

        Ok(Admission {
            member,
            session_id,
            authority: true,
            admitted_as: identity,
            deliveries: Vec::new(),
        })
    }

    /// Admit a participant to an existing session. Never grants authority.
    pub fn join(&mut self, secret: &str, identity: Participant) -> Result<Admission, BrokerError> {
        validate_identity(&identity)?;
        let index = self
            .find_session(secret)
            .ok_or(BrokerError::UnknownSession)?;
        let session = &mut self.sessions[index];

        if session.members.len() >= MAX_MEMBERS_PER_SESSION {
            return Err(BrokerError::SessionFull);
        }
        // Identity is self-asserted, so the one thing the broker CAN enforce is that it is unique
        // within the session. Without this, two members would share a participant id and every
        // presence/peer frame about them would be ambiguous — the caret-spoofing surface.
        //
        // The DISPLAY NAME is held to the same rule, and for the same reason: it (with the colour
        // swatch) is the only identity signal the UI actually shows, so admitting a second "Ada
        // Lovelace" would let a token-holder author edits that everyone attributes to the session
        // owner. Uniqueness is compared case- and whitespace-insensitively, because that is the
        // comparison a human reading the participant list is making.
        let display_key = identity.display_name.trim().to_lowercase();
        if session.members.iter().any(|m| {
            m.identity.id == identity.id
                || m.identity.display_name.trim().to_lowercase() == display_key
        }) {
            return Err(BrokerError::DuplicateIdentity);
        }

        let member = self.next_member;
        self.next_member += 1;
        let session = &mut self.sessions[index];
        let session_id = session.id.clone();

        // The joiner learns who is already here BEFORE the room learns about the joiner: the
        // authority answers a peer-join with the full document, and that answer must not race a
        // half-populated peer list on the joiner's side.
        let mut deliveries: Vec<Delivery> = session
            .members
            .iter()
            .map(|m| {
                (
                    member,
                    ServerFrame::PeerJoin {
                        peer: m.identity.clone(),
                    },
                )
            })
            .collect();
        deliveries.extend(session.members.iter().map(|m| {
            (
                m.id,
                ServerFrame::PeerJoin {
                    peer: identity.clone(),
                },
            )
        }));

        session.members.push(Member {
            id: member,
            identity: identity.clone(),
        });

        Ok(Admission {
            member,
            session_id,
            // Always false. Authority belongs to the member that CREATED the session and a fresh
            // connection can never be that one, whatever identity it presents.
            authority: false,
            admitted_as: identity,
            deliveries,
        })
    }

    /// Fan a CRDT update out to every other participant — never back to the sender.
    pub fn update(&mut self, member: MemberId, update: Vec<u8>) -> Vec<Delivery> {
        self.fan_out(member, |_| ServerFrame::Update {
            update: update.clone(),
        })
    }

    /// Fan a presence frame out, re-stamped with the sender's admitted identity.
    pub fn presence(&mut self, member: MemberId, presence: Presence) -> Vec<Delivery> {
        let Some(index) = self.find_member_session(member) else {
            return Vec::new();
        };
        let session = &self.sessions[index];
        let Some(sender) = session.members.iter().find(|m| m.id == member) else {
            return Vec::new();
        };
        // A frame may claim to be from anyone; what goes out is stamped from the identity this
        // connection was admitted under, so a peer holding the token cannot paint someone else's
        // caret (nor one labelled with a participant's own name somewhere they are not).
        let stamped = stamp_presence(&sender.identity, presence);
        session
            .members
            .iter()
            .filter(|m| m.id != member)
            .map(|m| {
                (
                    m.id,
                    ServerFrame::Presence {
                        presence: stamped.clone(),
                    },
                )
            })
            .collect()
    }

    /// Remove a member (an explicit leave, or a dropped connection).
    pub fn leave(&mut self, member: MemberId) -> Departure {
        let Some(index) = self.find_member_session(member) else {
            return Departure::default();
        };
        let session = &mut self.sessions[index];
        let Some(position) = session.members.iter().position(|m| m.id == member) else {
            return Departure::default();
        };
        let gone = session.members.remove(position);

        let deliveries: Vec<Delivery> = session
            .members
            .iter()
            .map(|m| {
                (
                    m.id,
                    ServerFrame::PeerLeave {
                        participant_id: gone.identity.id.clone(),
                    },
                )
            })
            .collect();

        // ADR 0013 left "authority leaves → end or hand off" open; this is the answer: END it.
        // Handing authority to a survivor means picking a winner over a network that may already be
        // partitioned, and two hosts each believing they own the canonical save is the lost-write
        // bug the whole authority rule exists to prevent.
        let closed = gone.id == session.authority || session.members.is_empty();
        let remaining: Vec<MemberId> = if closed {
            let ids = session.members.iter().map(|m| m.id).collect();
            self.sessions.remove(index);
            ids
        } else {
            Vec::new()
        };

        Departure {
            deliveries,
            session_closed: closed,
            remaining,
        }
    }

    /// Members currently in the session identified by `secret`, or 0 if there is no such session.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn member_count(&self, secret: &str) -> usize {
        self.find_session(secret)
            .map_or(0, |i| self.sessions[i].members.len())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }

    fn mint_member(&mut self) -> MemberId {
        let id = self.next_member;
        self.next_member += 1;
        id
    }

    /// Locate a session by its secret. Every candidate is compared in constant time and the scan
    /// never short-circuits, so neither the match nor its position is observable through timing.
    fn find_session(&self, secret: &str) -> Option<usize> {
        let mut found = None;
        for (index, session) in self.sessions.iter().enumerate() {
            if secrets_match(&session.secret, secret) {
                found = Some(index);
            }
        }
        found
    }

    fn find_member_session(&self, member: MemberId) -> Option<usize> {
        self.sessions
            .iter()
            .position(|s| s.members.iter().any(|m| m.id == member))
    }

    fn fan_out(&self, member: MemberId, frame: impl Fn(&Member) -> ServerFrame) -> Vec<Delivery> {
        let Some(index) = self.find_member_session(member) else {
            return Vec::new();
        };
        self.sessions[index]
            .members
            .iter()
            .filter(|m| m.id != member)
            .map(|m| (m.id, frame(m)))
            .collect()
    }
}

/// Whether a participant colour is safe to hand to the renderer.
///
/// The far side interpolates this into a `style` attribute (`--koi-presence-color: <colour>`), which
/// parses a whole declaration list — so a bare `;` in a colour is a CSS injection into a webview that
/// runs with no CSP. Length and "no control characters" do not stop that; a syntax bound does. Hex or a
/// bare CSS colour keyword covers everything Studio actually produces.
/// Mirrored by `safePresenceColor` in `src/editor/presence.ts`, which is the last line of defence at
/// the sink itself.
pub fn is_safe_color(color: &str) -> bool {
    if let Some(hex) = color.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    !color.is_empty() && color.len() <= 32 && color.chars().all(|c| c.is_ascii_alphabetic())
}

/// Validate an identity off the wire. Non-empty, bounded, no control characters, and a colour whose
/// syntax cannot escape the CSS declaration it ends up in.
pub fn validate_identity(identity: &Participant) -> Result<(), BrokerError> {
    let ok = |field: &str| {
        !field.is_empty()
            && field.len() <= MAX_IDENTITY_FIELD_LEN
            && !field.chars().any(char::is_control)
    };
    if ok(&identity.id)
        && ok(&identity.display_name)
        && ok(&identity.color)
        && is_safe_color(&identity.color)
    {
        Ok(())
    } else {
        Err(BrokerError::InvalidIdentity)
    }
}

/// Clamp a presence frame and stamp it with the identity the sender was admitted under.
pub fn stamp_presence(identity: &Participant, presence: Presence) -> Presence {
    let mut selection = presence.selection;
    selection.truncate(MAX_SELECTION_RANGES);
    Presence {
        participant_id: identity.id.clone(),
        display_name: identity.display_name.clone(),
        color: identity.color.clone(),
        cursor: presence.cursor,
        selection,
    }
}

// --- length-prefixed JSON codec ------------------------------------------------------------------

/// Write `frame` as a 4-byte big-endian length followed by its JSON body.
pub fn write_frame<W: Write, T: serde::Serialize>(w: &mut W, frame: &T) -> io::Result<()> {
    let body = serde_json::to_vec(frame).map_err(io::Error::other)?;
    if body.is_empty() || body.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "collaboration frame exceeds the wire limit",
        ));
    }
    w.write_all(&(body.len() as u32).to_be_bytes())?;
    w.write_all(&body)?;
    w.flush()
}

/// Read one frame. `Ok(None)` on a clean end of stream.
pub fn read_frame<R: Read, T: serde::de::DeserializeOwned>(r: &mut R) -> io::Result<Option<T>> {
    let mut header = [0u8; 4];
    let mut filled = 0;
    while filled < header.len() {
        match r.read(&mut header[filled..]) {
            // Nothing at all yet means the peer hung up cleanly between frames; mid-header it is a
            // truncation, which is an error rather than a silent, easily-missed no-op.
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "collaboration frame header truncated",
                ))
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }

    let len = u32::from_be_bytes(header) as usize;
    // Bound BEFORE allocating: the length is attacker-controlled, and honouring it verbatim is how
    // a single 4-byte header turns into a 4 GiB allocation.
    if len == 0 || len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "collaboration frame exceeds the wire limit",
        ));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

// --- tokens --------------------------------------------------------------------------------------

/// 128 CSPRNG bits, hex-encoded. The one credential guarding edit access to a domain model.
pub fn new_secret() -> String {
    let mut bytes = [0u8; SECRET_HEX_LEN / 2];
    // A predictable token is the whole vulnerability, so a failure to draw from the OS CSPRNG must
    // never fall back to something weaker — there is nothing safe to return here.
    getrandom::fill(&mut bytes).expect("the OS CSPRNG is required to open a collaboration session");
    bytes.iter().fold(String::new(), |mut hex, b| {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
        hex
    })
}

pub fn format_token(host: &str, port: u16, secret: &str, public_key: &str) -> String {
    format!("{TOKEN_SCHEME}{host}:{port}/{secret}/{public_key}")
}

/// Parse `koine-collab://<host>:<port>/<secret>/<public-key>` into its parts. Strict: anything else
/// is `None`.
///
/// The public key is the broker's X25519 static key, and it is what makes the token more than a
/// password: the joiner pins it through the Noise handshake (#1811, ADR 0017), so a machine in the
/// middle cannot answer for a broker whose key it does not hold. A token without one is refused
/// rather than dialled unencrypted — there is no downgrade path.
pub fn parse_token(token: &str) -> Option<(String, u16, String, [u8; PUBLIC_KEY_BYTES])> {
    let rest = token.trim().strip_prefix(TOKEN_SCHEME)?;
    let (authority, rest) = rest.split_once('/')?;
    let (secret, public_key) = rest.split_once('/')?;
    if secret.len() != SECRET_HEX_LEN
        || !secret
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return None;
    }
    let public_key = decode_public_key(public_key)?;
    // `rsplit_once` so a bracketed IPv6 literal (`[::1]:4321`) keeps its colons.
    let (host, port) = authority.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if host.is_empty() || port == 0 {
        return None;
    }
    Some((host.to_string(), port, secret.to_string(), public_key))
}

/// Constant-time secret comparison — no early exit on the first differing byte.
pub fn secrets_match(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

// --- carrying the frames: TCP sessions and relays -------------------------------------------------
//
// The broker above decides *what goes where*; everything below is the plumbing that moves it. Two
// roles, one protocol:
//
//   * **hosted session** — the desktop shell binds a listener, creates the session locally, and is
//     the document authority. It accepts `Join` only: a stranger must never be able to open a
//     session on someone's laptop, so `Create` over the wire is refused here.
//   * **relay** — the same accept loop with `Create` allowed and no local participant. That is the
//     entire difference, which is what makes "a configured relay brokers instead of the sidecar"
//     one protocol rather than two.

/// How long a fresh connection has to present its `Join`/`Create` frame before it is dropped —
/// otherwise an idle connection holds a slot for free.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long dialling a broker may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Accept-loop poll interval; the listener is non-blocking so shutdown never waits on a connection.
const ACCEPT_POLL: Duration = Duration::from_millis(25);
/// Ceiling on simultaneously-served connections, so a connection flood cannot spawn threads without
/// bound. Sized to every session being full at once, plus room for handshakes in flight.
pub const MAX_CONNECTIONS: usize = MAX_SESSIONS * MAX_MEMBERS_PER_SESSION + 16;

/// Where the frames addressed to *this* machine's participant go — Tauri events in the app, a
/// channel in tests. Keeps this module free of any Tauri dependency.
pub trait LocalSink: Send + Sync + 'static {
    fn deliver(&self, frame: ServerFrame);
}

/// What `collab_start` hands back to the frontend — mirrors `CollabSessionInfo` in src/host/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    /// The full `koine-collab://host:port/secret` join token. A SECRET: never log it.
    pub token: String,
    pub authority: bool,
    #[serde(rename = "self")]
    pub admitted_as: Participant,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panicking connection thread must not wedge the whole session; the broker's invariants are
    // re-established by the next call either way.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The broker plus the sockets its deliveries travel over.
struct Hub {
    broker: Mutex<Broker>,
    /// One encrypted sending half per connected member. There is no plaintext variant: a connection
    /// only reaches this table after its Noise handshake completed (#1811).
    writers: Mutex<HashMap<MemberId, NoiseWriter<TcpStream>>>,
    sink: Arc<dyn LocalSink>,
    /// This broker's X25519 identity — a session's, or a relay's. Its public half is what a joiner
    /// pins, so a machine in the middle cannot answer in its place.
    keypair: StaticKeypair,
    /// The participant running in this process, if any. A relay has none.
    local_member: Option<MemberId>,
    connections: Arc<AtomicUsize>,
}

impl Hub {
    fn dispatch(&self, deliveries: Vec<Delivery>) {
        for (target, frame) in deliveries {
            if Some(target) == self.local_member {
                self.sink.deliver(frame);
                continue;
            }
            let mut writers = lock(&self.writers);
            let broken = match writers.get_mut(&target) {
                Some(writer) => write_frame(writer, &frame).is_err(),
                None => false,
            };
            // A peer we can no longer write to is gone; drop it now rather than retrying forever.
            if broken {
                if let Some(writer) = writers.remove(&target) {
                    let _ = writer.get_ref().shutdown(Shutdown::Both);
                }
            }
        }
    }

    /// Remove a member and hang up on whoever the departure stranded.
    fn depart(&self, member: MemberId) {
        let departure = lock(&self.broker).leave(member);
        self.dispatch(departure.deliveries);

        let mut writers = lock(&self.writers);
        if let Some(writer) = writers.remove(&member) {
            let _ = writer.get_ref().shutdown(Shutdown::Both);
        }
        if departure.session_closed {
            for stranded in departure.remaining {
                if let Some(writer) = writers.remove(&stranded) {
                    let _ = writer.get_ref().shutdown(Shutdown::Both);
                }
            }
        }
    }

    fn close_all(&self) {
        for (_, writer) in lock(&self.writers).drain() {
            let _ = writer.get_ref().shutdown(Shutdown::Both);
        }
    }
}

fn serve(listener: TcpListener, hub: Arc<Hub>, shutdown: Arc<AtomicBool>, allow_create: bool) {
    // Non-blocking so `stop()` is not held hostage by a listener parked in `accept`.
    if listener.set_nonblocking(true).is_err() {
        return;
    }
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                if hub.connections.load(Ordering::SeqCst) >= MAX_CONNECTIONS {
                    let _ = stream.shutdown(Shutdown::Both);
                    continue;
                }
                hub.connections.fetch_add(1, Ordering::SeqCst);
                let hub = Arc::clone(&hub);
                let shutdown = Arc::clone(&shutdown);
                thread::spawn(move || {
                    serve_connection(stream, &hub, &shutdown, allow_create);
                    hub.connections.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => thread::sleep(ACCEPT_POLL),
            Err(_) => break,
        }
    }
}

fn serve_connection(
    mut stream: TcpStream,
    hub: &Arc<Hub>,
    shutdown: &Arc<AtomicBool>,
    allow_create: bool,
) {
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));

    // Encryption comes FIRST — before the first byte of protocol is read, let alone parsed. A peer
    // that cannot complete the Noise handshake (a plain-TCP speaker, a port scanner, anyone without
    // this broker's public key) is dropped here without an answer, so the join secret it would have
    // presented never crosses the network in the clear (#1811, ADR 0017).
    let Ok(transport) = handshake_responder(&mut stream, &hub.keypair) else {
        return;
    };
    let Ok(writer_stream) = stream.try_clone() else {
        return;
    };
    let (mut reader, mut writer) = split(&transport, stream, writer_stream);

    let hello: Option<ClientFrame> = read_frame(&mut reader).ok().flatten();

    let (admitted, secret) = match hello {
        Some(ClientFrame::Join { secret, identity }) => {
            (lock(&hub.broker).join(&secret, identity), None)
        }
        // Only a relay lets a caller open a session over the wire. In the desktop shell this arm is
        // off, so a peer that reaches the listener can join the session the user started and nothing
        // else.
        Some(ClientFrame::Create { identity }) if allow_create => {
            let secret = new_secret();
            (
                lock(&hub.broker).create(identity, secret.clone()),
                Some(secret),
            )
        }
        _ => {
            let _ = write_frame(
                &mut writer,
                &ServerFrame::Rejected {
                    reason: "expected a join frame".to_string(),
                },
            );
            return;
        }
    };

    let admission = match admitted {
        Ok(admission) => admission,
        Err(err) => {
            let _ = write_frame(
                &mut writer,
                &ServerFrame::Rejected {
                    reason: err.message().to_string(),
                },
            );
            return;
        }
    };
    let member = admission.member;

    // The admission goes out through the very writer the table will hold, because a Noise channel
    // counts its own messages: two writers over one connection would each start from nonce zero and
    // the second frame either way would fail to authenticate.
    //
    // Write and publish under ONE hold of the writers lock. `dispatch` takes the same lock per
    // delivery, so this is what orders the protocol: a `PeerJoin` that another thread produced for
    // this member while we were still writing waits here and lands *after* the admission, instead of
    // finding no writer and being dropped — or, worse, overtaking the frame the client is blocked
    // reading.
    let admitted_frame = ServerFrame::Admitted {
        session_id: admission.session_id.clone(),
        authority: admission.authority,
        admitted_as: admission.admitted_as.clone(),
        secret,
    };
    let admitted_ok = {
        let mut writers = lock(&hub.writers);
        let ok = write_frame(&mut writer, &admitted_frame).is_ok();
        if ok {
            writers.insert(member, writer);
        }
        ok
    };
    if !admitted_ok {
        hub.depart(member);
        return;
    }
    hub.dispatch(admission.deliveries);

    // Admitted: the connection is now long-lived, so the handshake deadline no longer applies.
    let _ = reader.get_ref().set_read_timeout(None);
    loop {
        if shutdown.load(Ordering::SeqCst) {
            break;
        }
        match read_frame::<_, ClientFrame>(&mut reader) {
            Ok(Some(ClientFrame::Update { update })) => {
                let deliveries = lock(&hub.broker).update(member, update);
                hub.dispatch(deliveries);
            }
            Ok(Some(ClientFrame::Presence { presence })) => {
                let deliveries = lock(&hub.broker).presence(member, presence);
                hub.dispatch(deliveries);
            }
            // `Leave`, a clean hang-up, a second handshake frame (a protocol error), or a malformed
            // frame all end the same way: this member is done.
            _ => break,
        }
    }
    hub.depart(member);
}

/// A session this process hosts and owns the document for.
pub struct HostedSession {
    hub: Arc<Hub>,
    shutdown: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
    local_member: MemberId,
    pub info: SessionInfo,
}

impl HostedSession {
    pub fn send_update(&self, update: Vec<u8>) {
        let deliveries = lock(&self.hub.broker).update(self.local_member, update);
        self.hub.dispatch(deliveries);
    }

    pub fn send_presence(&self, presence: Presence) {
        let deliveries = lock(&self.hub.broker).presence(self.local_member, presence);
        self.hub.dispatch(deliveries);
    }

    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // Departing as the authority ends the session: peers are told, then hung up on.
        self.hub.depart(self.local_member);
        self.hub.close_all();
        if let Some(handle) = self.accept.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for HostedSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Open a session on `bind_host`, becoming its document authority.
///
/// `bind_host` is both the interface bound and the address advertised in the join token, so it must
/// be an address participants can actually dial. The default is loopback — a listener that appears
/// on the workshop wifi because someone clicked "start session" would be a surprise, and opening one
/// to the LAN should be a deliberate act.
pub fn host_session(
    bind_host: &str,
    identity: Participant,
    sink: Arc<dyn LocalSink>,
) -> Result<HostedSession, String> {
    validate_identity(&identity).map_err(|e| e.message().to_string())?;
    let listener = TcpListener::bind((bind_host, 0))
        .map_err(|e| format!("could not open a collaboration session on {bind_host}: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the collaboration session address: {e}"))?
        .port();

    let secret = new_secret();
    // One X25519 identity per session, minted here and published in the token. Nothing persists it,
    // so there is no key to protect between sessions and a joiner's pin is scoped to this one.
    let keypair = StaticKeypair::generate().map_err(|e| e.to_string())?;
    let mut broker = Broker::new();
    let admission = broker
        .create(identity, secret.clone())
        .map_err(|e| e.message().to_string())?;
    let token = format_token(bind_host, port, &secret, &keypair.public_hex());

    let hub = Arc::new(Hub {
        broker: Mutex::new(broker),
        writers: Mutex::new(HashMap::new()),
        sink,
        keypair,
        local_member: Some(admission.member),
        connections: Arc::new(AtomicUsize::new(0)),
    });
    let shutdown = Arc::new(AtomicBool::new(false));
    let accept = thread::spawn({
        let hub = Arc::clone(&hub);
        let shutdown = Arc::clone(&shutdown);
        move || serve(listener, hub, shutdown, false)
    });

    Ok(HostedSession {
        hub,
        shutdown,
        accept: Some(accept),
        local_member: admission.member,
        info: SessionInfo {
            session_id: admission.session_id,
            token,
            authority: true,
            admitted_as: admission.admitted_as,
        },
    })
}

/// A relay: the same broker, reachable by both participants, belonging to neither.
pub struct Relay {
    hub: Arc<Hub>,
    shutdown: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
    /// `host:port` a participant dials to reach this relay.
    #[cfg_attr(not(test), allow(dead_code))]
    pub endpoint: String,
}

struct DiscardSink;
impl LocalSink for DiscardSink {
    fn deliver(&self, _frame: ServerFrame) {}
}

/// Run a relay on `bind_host`. A relay has no participant of its own, which is exactly why it may
/// honour `Create` over the wire where a hosted session may not.
///
/// The Studio app never calls this — it hosts. It is here because it is the reference implementation
/// of what a user-configured relay has to do, and because it is what lets the relay path be tested
/// end-to-end rather than asserted about.
#[cfg_attr(not(test), allow(dead_code))]
pub fn run_relay(bind_host: &str) -> Result<Relay, String> {
    let listener = TcpListener::bind((bind_host, 0))
        .map_err(|e| format!("could not start a collaboration relay on {bind_host}: {e}"))?;
    let addr: SocketAddr = listener
        .local_addr()
        .map_err(|e| format!("could not read the relay address: {e}"))?;
    // A relay's key is minted once at startup and published in its endpoint, because that endpoint is
    // what an operator hands out and what a participant pins in `collab.relayUrl`.
    let keypair = StaticKeypair::generate().map_err(|e| e.to_string())?;
    let endpoint = format!("{bind_host}:{}/{}", addr.port(), keypair.public_hex());

    let hub = Arc::new(Hub {
        broker: Mutex::new(Broker::new()),
        writers: Mutex::new(HashMap::new()),
        sink: Arc::new(DiscardSink),
        keypair,
        local_member: None,
        connections: Arc::new(AtomicUsize::new(0)),
    });
    let shutdown = Arc::new(AtomicBool::new(false));
    let accept = thread::spawn({
        let hub = Arc::clone(&hub);
        let shutdown = Arc::clone(&shutdown);
        move || serve(listener, hub, shutdown, true)
    });

    Ok(Relay {
        hub,
        shutdown,
        accept: Some(accept),
        endpoint,
    })
}

impl Relay {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.hub.close_all();
        if let Some(handle) = self.accept.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A session brokered elsewhere — joined by token, or created through a configured relay.
#[derive(Debug)]
pub struct RemoteSession {
    /// The encrypted sending half. One writer for the whole connection: a Noise channel counts its
    /// own messages, so a second one would restart the nonce run and desynchronise the peer.
    writer: Mutex<NoiseWriter<TcpStream>>,
    shutdown: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    pub info: SessionInfo,
}

impl RemoteSession {
    pub fn send_update(&self, update: Vec<u8>) {
        self.send(&ClientFrame::Update { update });
    }

    pub fn send_presence(&self, presence: Presence) {
        self.send(&ClientFrame::Presence { presence });
    }

    fn send(&self, frame: &ClientFrame) {
        // Best effort by design: the CRDT replica is the source of truth and re-merges on reconnect,
        // so a dropped frame costs a round trip, not an edit.
        let _ = write_frame(&mut *lock(&self.writer), frame);
    }

    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        {
            let mut writer = lock(&self.writer);
            let _ = write_frame(&mut *writer, &ClientFrame::Leave);
            let _ = writer.get_ref().shutdown(Shutdown::Both);
        }
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for RemoteSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Join a session by token. The token names the broker to dial and carries the secret to present.
pub fn join_session(
    token: &str,
    identity: Participant,
    sink: Arc<dyn LocalSink>,
) -> Result<RemoteSession, String> {
    let (host, port, secret, broker_key) =
        parse_token(token).ok_or_else(|| "that is not a valid join token".to_string())?;
    let hello = ClientFrame::Join {
        secret,
        identity: identity.clone(),
    };
    handshake(&host, port, broker_key, hello, token.to_string(), sink)
}

/// Open a session on a user-configured relay: same protocol, `Create` instead of `Join`.
/// `relay` is `host:port/<public-key>`, optionally with the `koine-collab://` scheme.
///
/// The key is not optional. A relay is a machine belonging to neither participant, so dialling one
/// without pinning its key would be exactly the "looks encrypted, authenticates nobody" transport this
/// change exists to avoid — the relay you reached would be whoever answered.
pub fn create_via_relay(
    relay: &str,
    identity: Participant,
    sink: Arc<dyn LocalSink>,
) -> Result<RemoteSession, String> {
    const SHAPE: &str = "the collaboration relay must be host:port/<public-key>";
    let trimmed = relay
        .trim()
        .trim_start_matches(TOKEN_SCHEME)
        .trim_end_matches('/');
    let (authority, key_hex) = trimmed.split_once('/').ok_or_else(|| SHAPE.to_string())?;
    let broker_key = decode_public_key(key_hex).ok_or_else(|| SHAPE.to_string())?;
    let (host, port) = authority
        .rsplit_once(':')
        .ok_or_else(|| SHAPE.to_string())?;
    let port: u16 = port.parse().map_err(|_| SHAPE.to_string())?;
    if host.is_empty() || port == 0 {
        return Err(SHAPE.to_string());
    }
    // The token is composed below, once the relay has minted the secret.
    handshake(
        host,
        port,
        broker_key,
        ClientFrame::Create { identity },
        String::new(),
        sink,
    )
}

fn handshake(
    host: &str,
    port: u16,
    broker_key: [u8; PUBLIC_KEY_BYTES],
    hello: ClientFrame,
    token: String,
    sink: Arc<dyn LocalSink>,
) -> Result<RemoteSession, String> {
    let identity = match &hello {
        ClientFrame::Join { identity, .. } | ClientFrame::Create { identity } => identity.clone(),
        _ => return Err("unsupported collaboration handshake".to_string()),
    };
    validate_identity(&identity).map_err(|e| e.message().to_string())?;
    // We know which side of the handshake we are on, so the broker's answer is not the last word on it.
    // A hostile broker that answered a JOIN with `authority: true` would make this editor seed the
    // shared document from its own buffer and broadcast it — turning an invitation link into document
    // exfiltration. Authority is only ever believed for the connection that asked to CREATE.
    let may_be_authority = matches!(hello, ClientFrame::Create { .. });

    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|_| format!("could not resolve the collaboration broker at {host}:{port}"))?
        .next()
        .ok_or_else(|| format!("could not resolve the collaboration broker at {host}:{port}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)
        .map_err(|e| format!("could not reach the collaboration broker at {host}:{port}: {e}"))?;
    let _ = stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT));

    // Encrypt before saying anything. `broker_key` came from the join token (or the configured relay
    // address), so completing this handshake is also what proves the far end is the broker we were
    // invited to and not whoever intercepted the connection.
    let transport = handshake_initiator(&mut stream, &broker_key).map_err(|_| {
        format!("could not open an encrypted channel to the collaboration broker at {host}:{port}")
    })?;
    let read_stream = stream
        .try_clone()
        .map_err(|e| format!("could not listen to the collaboration broker: {e}"))?;
    let (mut reader, mut writer) = split(&transport, read_stream, stream);

    write_frame(&mut writer, &hello)
        .map_err(|e| format!("could not greet the collaboration broker: {e}"))?;

    let reply: Option<ServerFrame> = read_frame(&mut reader)
        .map_err(|e| format!("the collaboration broker did not answer: {e}"))?;
    let (session_id, authority, admitted_as, secret) = match reply {
        Some(ServerFrame::Admitted {
            session_id,
            authority,
            admitted_as,
            secret,
        }) => (session_id, authority, admitted_as, secret),
        // The broker's own words — already scrubbed of anything the caller supplied.
        Some(ServerFrame::Rejected { reason }) => return Err(reason),
        _ => return Err("the collaboration broker did not answer".to_string()),
    };

    let token = if token.is_empty() {
        let secret = secret.ok_or_else(|| {
            "the collaboration relay admitted the session without a token".to_string()
        })?;
        // The invitee has to pin the same relay key we just pinned, so it travels in the token.
        format_token(host, port, &secret, &encode_hex(&broker_key))
    } else {
        token
    };

    let authority = authority && may_be_authority;

    let _ = reader.get_ref().set_read_timeout(None);
    let shutdown = Arc::new(AtomicBool::new(false));
    let handle = thread::spawn({
        let shutdown = Arc::clone(&shutdown);
        move || read_loop(reader, sink, shutdown)
    });

    Ok(RemoteSession {
        writer: Mutex::new(writer),
        shutdown,
        reader: Some(handle),
        info: SessionInfo {
            session_id,
            token,
            authority,
            admitted_as,
        },
    })
}

/// Whether a frame arriving FROM a broker is fit to hand to the editor.
///
/// A hosted session validates what it fans out, but the broker at the other end of a joined session is
/// only as trustworthy as whoever the user pointed at — a relay, or a peer's desktop. So the same
/// bounds apply on the way in: an over-long name or a colour that can break out of a CSS declaration
/// is dropped here rather than rendered.
fn is_deliverable(frame: &ServerFrame) -> bool {
    match frame {
        ServerFrame::PeerJoin { peer } => validate_identity(peer).is_ok(),
        ServerFrame::Presence { presence } => {
            validate_identity(&Participant {
                id: presence.participant_id.clone(),
                display_name: presence.display_name.clone(),
                color: presence.color.clone(),
            })
            .is_ok()
                && presence.selection.len() <= MAX_SELECTION_RANGES
        }
        ServerFrame::PeerLeave { participant_id } => {
            !participant_id.is_empty()
                && participant_id.len() <= MAX_IDENTITY_FIELD_LEN
                && !participant_id.chars().any(char::is_control)
        }
        _ => true,
    }
}

fn read_loop(
    mut reader: NoiseReader<TcpStream>,
    sink: Arc<dyn LocalSink>,
    shutdown: Arc<AtomicBool>,
) {
    let mut peers: Vec<String> = Vec::new();
    loop {
        match read_frame::<_, ServerFrame>(&mut reader) {
            Ok(Some(frame)) if !is_deliverable(&frame) => continue,
            Ok(Some(frame)) => {
                match &frame {
                    ServerFrame::PeerJoin { peer } => peers.push(peer.id.clone()),
                    ServerFrame::PeerLeave { participant_id } => {
                        peers.retain(|id| id != participant_id)
                    }
                    _ => {}
                }
                sink.deliver(frame);
            }
            _ => break,
        }
    }
    // The broker is gone, so every peer it was relaying is unreachable. Say so through the one
    // contract event that exists rather than leaving other people's carets frozen on screen.
    if !shutdown.load(Ordering::SeqCst) {
        for participant_id in peers {
            sink.deliver(ServerFrame::PeerLeave { participant_id });
        }
    }
}

// --- tests ---------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::sync::mpsc::{self, Receiver, Sender};

    fn participant(id: &str) -> Participant {
        Participant {
            id: id.to_string(),
            display_name: format!("{id} display"),
            color: "#e8637c".to_string(),
        }
    }

    fn presence_of(id: &str, cursor: u32) -> Presence {
        Presence {
            participant_id: id.to_string(),
            display_name: format!("{id} display"),
            color: "#e8637c".to_string(),
            cursor,
            selection: Vec::new(),
        }
    }

    /// A broker with a session and `extra` joiners; returns (broker, secret, authority, joiners).
    fn with_session(extra: &[&str]) -> (Broker, String, MemberId, Vec<MemberId>) {
        let mut broker = Broker::new();
        let secret = "a".repeat(SECRET_HEX_LEN);
        let created = broker
            .create(participant("ada"), secret.clone())
            .expect("create");
        let joiners = extra
            .iter()
            .map(|id| broker.join(&secret, participant(id)).expect("join").member)
            .collect();
        (broker, secret, created.member, joiners)
    }

    // --- create / authority ---------------------------------------------------------------------

    #[test]
    fn create_admits_the_creator_as_the_authority() {
        let mut broker = Broker::new();
        let admission = broker
            .create(participant("ada"), "a".repeat(SECRET_HEX_LEN))
            .expect("create");

        assert!(admission.authority);
        assert_eq!(admission.admitted_as, participant("ada"));
        assert!(
            admission.deliveries.is_empty(),
            "nobody else is in the room yet"
        );
    }

    #[test]
    fn a_joiner_is_never_the_authority_even_presenting_the_creators_identity() {
        let mut broker = Broker::new();
        let secret = "a".repeat(SECRET_HEX_LEN);
        broker
            .create(participant("ada"), secret.clone())
            .expect("create");

        // The impersonation attempt: same participant id as the creator. It is refused because two
        // members may not share an identity — and even a *different* id would not have been granted
        // authority, since authority is bound to the creating connection.
        let impostor = broker.join(&secret, participant("ada"));
        assert_eq!(impostor.unwrap_err(), BrokerError::DuplicateIdentity);

        let joiner = broker.join(&secret, participant("grace")).expect("join");
        assert!(
            !joiner.authority,
            "authority belongs to the creating connection"
        );
    }

    #[test]
    fn join_with_an_unknown_secret_is_rejected_without_echoing_the_token() {
        let mut broker = Broker::new();
        broker
            .create(participant("ada"), "a".repeat(SECRET_HEX_LEN))
            .expect("create");

        let err = broker
            .join(&"b".repeat(SECRET_HEX_LEN), participant("grace"))
            .unwrap_err();

        assert_eq!(err, BrokerError::UnknownSession);
        assert!(
            !err.message().contains(&"b".repeat(SECRET_HEX_LEN)),
            "the rejection must not echo the token that was tried: {}",
            err.message()
        );
    }

    #[test]
    fn join_replays_existing_peers_to_the_joiner_before_announcing_it() {
        let (mut broker, secret, ada, _) = with_session(&[]);
        let admission = broker.join(&secret, participant("grace")).expect("join");
        let grace = admission.member;

        assert_eq!(
            admission.deliveries,
            vec![
                (
                    grace,
                    ServerFrame::PeerJoin {
                        peer: participant("ada")
                    }
                ),
                (
                    ada,
                    ServerFrame::PeerJoin {
                        peer: participant("grace")
                    }
                ),
            ],
            "the joiner learns who is already there before the room learns about the joiner"
        );
    }

    #[test]
    fn a_colour_that_could_escape_its_css_declaration_is_refused() {
        assert!(is_safe_color("#e8637c"));
        assert!(is_safe_color("#fff"));
        assert!(is_safe_color("rebeccapurple"));
        for hostile in [
            "red;background-image:url(http://evil.example/p)",
            "red;position:fixed;inset:0",
            "#fff;color:red",
            "var(--x)",
            "url(x)",
            "",
        ] {
            assert!(!is_safe_color(hostile), "must refuse {hostile:?}");
        }

        let mut broker = Broker::new();
        let styled = Participant {
            id: "mallory".into(),
            display_name: "Mallory".into(),
            color: "red;background-image:url(http://evil.example/p)".into(),
        };
        assert_eq!(
            broker
                .create(styled, "a".repeat(SECRET_HEX_LEN))
                .unwrap_err(),
            BrokerError::InvalidIdentity
        );
    }

    #[test]
    fn a_joiner_reusing_an_incumbents_display_name_is_refused() {
        let (mut broker, secret, _, _) = with_session(&[]);
        // A distinct id, but the same label the participant list shows — which is the whole identity
        // signal a human has to go on.
        let impostor = Participant {
            id: "not-ada".into(),
            display_name: "  ADA DISPLAY  ".into(),
            color: "#123456".into(),
        };
        assert_eq!(
            broker.join(&secret, impostor).unwrap_err(),
            BrokerError::DuplicateIdentity
        );
    }

    #[test]
    fn a_session_is_capped_at_its_member_limit() {
        let mut broker = Broker::new();
        let secret = "a".repeat(SECRET_HEX_LEN);
        broker
            .create(participant("ada"), secret.clone())
            .expect("create");
        for i in 1..MAX_MEMBERS_PER_SESSION {
            broker
                .join(&secret, participant(&format!("p{i}")))
                .expect("join within the cap");
        }

        let over = broker.join(&secret, participant("one-too-many"));
        assert_eq!(over.unwrap_err(), BrokerError::SessionFull);
    }

    #[test]
    fn an_invalid_identity_is_refused() {
        let mut broker = Broker::new();
        let secret = "a".repeat(SECRET_HEX_LEN);

        let empty = Participant {
            id: String::new(),
            display_name: "x".into(),
            color: "#fff".into(),
        };
        assert_eq!(
            broker.create(empty, secret.clone()).unwrap_err(),
            BrokerError::InvalidIdentity
        );

        let huge = Participant {
            id: "a".repeat(MAX_IDENTITY_FIELD_LEN + 1),
            display_name: "x".into(),
            color: "#fff".into(),
        };
        assert_eq!(
            broker.create(huge, secret.clone()).unwrap_err(),
            BrokerError::InvalidIdentity
        );

        let control = Participant {
            id: "ada\u{0}".into(),
            display_name: "x".into(),
            color: "#fff".into(),
        };
        assert_eq!(
            broker.create(control, secret).unwrap_err(),
            BrokerError::InvalidIdentity
        );
    }

    // --- fan-out --------------------------------------------------------------------------------

    #[test]
    fn an_update_reaches_every_other_participant_but_not_the_sender() {
        let (mut broker, _, ada, joiners) = with_session(&["grace", "linus"]);
        let (grace, linus) = (joiners[0], joiners[1]);

        let deliveries = broker.update(ada, vec![1, 2, 3]);

        assert_eq!(deliveries.len(), 2);
        assert!(deliveries.iter().all(|(_, frame)| frame
            == &ServerFrame::Update {
                update: vec![1, 2, 3]
            }));
        let targets: Vec<MemberId> = deliveries.iter().map(|(m, _)| *m).collect();
        assert!(targets.contains(&grace) && targets.contains(&linus));
        assert!(!targets.contains(&ada), "never echoed back to the sender");
    }

    #[test]
    fn an_update_from_an_unknown_member_goes_nowhere() {
        let (mut broker, _, _, _) = with_session(&["grace"]);
        assert!(broker.update(9999, vec![1]).is_empty());
        assert!(broker.presence(9999, presence_of("ghost", 0)).is_empty());
    }

    #[test]
    fn presence_is_stamped_with_the_senders_admitted_identity() {
        let (mut broker, _, ada, joiners) = with_session(&["grace"]);
        let grace = joiners[0];

        // Grace addresses a presence frame as Ada — the caret-spoofing attempt.
        let spoofed = Presence {
            participant_id: "ada".into(),
            display_name: "Ada".into(),
            color: "#000000".into(),
            cursor: 7,
            selection: vec![Range { from: 1, to: 2 }],
        };
        let deliveries = broker.presence(grace, spoofed);

        assert_eq!(
            deliveries,
            vec![(
                ada,
                ServerFrame::Presence {
                    presence: Presence {
                        participant_id: "grace".into(),
                        display_name: "grace display".into(),
                        color: "#e8637c".into(),
                        cursor: 7,
                        selection: vec![Range { from: 1, to: 2 }],
                    }
                }
            )],
            "identity is re-stamped from the admitted member, never taken from the frame"
        );
    }

    #[test]
    fn presence_selection_ranges_are_bounded() {
        let identity = participant("grace");
        let stamped = stamp_presence(
            &identity,
            Presence {
                participant_id: "grace".into(),
                display_name: "grace display".into(),
                color: "#e8637c".into(),
                cursor: 0,
                selection: vec![Range { from: 0, to: 1 }; MAX_SELECTION_RANGES + 10],
            },
        );
        assert_eq!(stamped.selection.len(), MAX_SELECTION_RANGES);
    }

    // --- leave ----------------------------------------------------------------------------------

    #[test]
    fn a_joiner_leaving_notifies_the_rest_and_keeps_the_session_open() {
        let (mut broker, secret, ada, joiners) = with_session(&["grace", "linus"]);
        let (grace, linus) = (joiners[0], joiners[1]);

        let departure = broker.leave(grace);

        assert!(!departure.session_closed);
        assert_eq!(departure.deliveries.len(), 2);
        for target in [ada, linus] {
            assert!(departure.deliveries.contains(&(
                target,
                ServerFrame::PeerLeave {
                    participant_id: "grace".into()
                }
            )));
        }
        assert_eq!(broker.member_count(&secret), 2);
    }

    #[test]
    fn the_authority_leaving_closes_the_session_for_everyone() {
        let (mut broker, secret, ada, joiners) = with_session(&["grace"]);
        let grace = joiners[0];

        let departure = broker.leave(ada);

        assert!(
            departure.session_closed,
            "there is no authority hand-off: the session ends (ADR 0013 left this open; this is the choice)"
        );
        assert_eq!(departure.remaining, vec![grace]);
        assert!(departure.deliveries.contains(&(
            grace,
            ServerFrame::PeerLeave {
                participant_id: "ada".into()
            }
        )));
        assert_eq!(broker.member_count(&secret), 0);
        assert!(broker.is_empty());
        assert_eq!(
            broker.join(&secret, participant("late")).unwrap_err(),
            BrokerError::UnknownSession,
            "the secret dies with the session"
        );
    }

    #[test]
    fn leaving_twice_is_inert() {
        let (mut broker, _, _, joiners) = with_session(&["grace"]);
        broker.leave(joiners[0]);
        assert_eq!(broker.leave(joiners[0]), Departure::default());
    }

    #[test]
    fn the_last_member_leaving_removes_the_session() {
        let (mut broker, secret, ada, _) = with_session(&[]);
        let departure = broker.leave(ada);
        assert!(departure.session_closed);
        assert!(departure.deliveries.is_empty());
        assert_eq!(broker.member_count(&secret), 0);
    }

    #[test]
    fn the_host_refuses_more_than_its_session_cap() {
        let mut broker = Broker::new();
        for i in 0..MAX_SESSIONS {
            broker
                .create(participant(&format!("p{i}")), format!("{i:0>32}"))
                .expect("create within the cap");
        }
        assert_eq!(
            broker
                .create(participant("over"), "f".repeat(SECRET_HEX_LEN))
                .unwrap_err(),
            BrokerError::TooManySessions
        );
    }

    // --- codec ----------------------------------------------------------------------------------

    #[test]
    fn a_second_session_may_not_reuse_a_live_secret() {
        let mut broker = Broker::new();
        let secret = "a".repeat(SECRET_HEX_LEN);
        broker
            .create(participant("ada"), secret.clone())
            .expect("create");
        assert_eq!(
            broker.create(participant("grace"), secret).unwrap_err(),
            BrokerError::SecretInUse,
            "two sessions behind one token would make the lookup ambiguous"
        );
    }

    #[test]
    fn a_frame_round_trips_through_the_length_prefixed_codec() {
        let frame = ClientFrame::Join {
            secret: "a".repeat(SECRET_HEX_LEN),
            identity: participant("ada"),
        };
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, &frame).expect("write");

        let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        assert_eq!(len, buf.len() - 4, "the prefix is the body length");

        let mut cur = Cursor::new(buf);
        let got: Option<ClientFrame> = read_frame(&mut cur).expect("read");
        assert_eq!(got, Some(frame));
        assert_eq!(
            read_frame::<_, ClientFrame>(&mut cur).expect("eof"),
            None,
            "a clean end of stream is not an error"
        );
    }

    #[test]
    fn an_oversize_declared_length_is_refused_before_allocating() {
        // Only a 4-byte header: an honest reader would now try to allocate 4 GiB.
        let header = (u32::MAX).to_be_bytes().to_vec();
        let mut cur = Cursor::new(header);
        let err = read_frame::<_, ClientFrame>(&mut cur).expect_err("must refuse");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_truncated_frame_is_an_error_not_a_silent_eof() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, &ClientFrame::Leave).expect("write");
        buf.pop();
        let mut cur = Cursor::new(buf);
        assert!(read_frame::<_, ClientFrame>(&mut cur).is_err());
    }

    #[test]
    fn the_update_frame_carries_bytes_verbatim() {
        let frame = ServerFrame::Update {
            update: vec![0, 255, 17],
        };
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, &frame).expect("write");
        let mut cur = Cursor::new(buf);
        assert_eq!(read_frame(&mut cur).expect("read"), Some(frame));
    }

    #[test]
    fn admitted_serialises_self_under_the_typescript_field_name() {
        let json = serde_json::to_string(&ServerFrame::Admitted {
            session_id: "s1".into(),
            authority: true,
            admitted_as: participant("ada"),
            secret: None,
        })
        .expect("serialise");
        assert!(json.contains("\"self\""), "CollabSessionInfo.self: {json}");
        assert!(json.contains("\"sessionId\""), "camelCase for TS: {json}");
        assert!(json.contains("\"displayName\""), "camelCase for TS: {json}");
    }

    // --- tokens ---------------------------------------------------------------------------------

    #[test]
    fn a_token_round_trips_through_format_and_parse() {
        let secret = "a".repeat(SECRET_HEX_LEN);
        let key_hex = "b".repeat(PUBLIC_KEY_HEX_LEN);
        let token = format_token("127.0.0.1", 4321, &secret, &key_hex);
        assert_eq!(
            token,
            format!("{TOKEN_SCHEME}127.0.0.1:4321/{secret}/{key_hex}")
        );
        assert_eq!(
            parse_token(&token),
            Some((
                "127.0.0.1".to_string(),
                4321,
                secret,
                decode_public_key(&key_hex).expect("key")
            ))
        );
    }

    #[test]
    fn parse_token_is_strict() {
        let secret = "a".repeat(SECRET_HEX_LEN);
        let key = "b".repeat(PUBLIC_KEY_HEX_LEN);
        for bad in [
            String::new(),
            format!("127.0.0.1:4321/{secret}/{key}"),
            format!("{TOKEN_SCHEME}127.0.0.1/{secret}/{key}"),
            format!("{TOKEN_SCHEME}127.0.0.1:99999/{secret}/{key}"),
            format!("{TOKEN_SCHEME}127.0.0.1:4321/short/{key}"),
            format!(
                "{TOKEN_SCHEME}127.0.0.1:4321/{}/{key}",
                "z".repeat(SECRET_HEX_LEN)
            ),
            format!("{TOKEN_SCHEME}:4321/{secret}/{key}"),
            // The pinned key is what stops a machine in the middle answering for the broker, so a
            // token missing or mangling it is refused outright — never dialled unencrypted (#1811).
            format!("{TOKEN_SCHEME}127.0.0.1:4321/{secret}"),
            format!("{TOKEN_SCHEME}127.0.0.1:4321/{secret}/"),
            format!(
                "{TOKEN_SCHEME}127.0.0.1:4321/{secret}/{}",
                "b".repeat(PUBLIC_KEY_HEX_LEN - 1)
            ),
            format!("{TOKEN_SCHEME}127.0.0.1:4321/{secret}/{key}/extra"),
            format!(
                "{TOKEN_SCHEME}127.0.0.1:4321/{secret}/{}",
                "Z".repeat(PUBLIC_KEY_HEX_LEN)
            ),
        ] {
            assert_eq!(parse_token(&bad), None, "must reject {bad:?}");
        }
    }

    #[test]
    fn a_hosted_session_publishes_a_fresh_public_key_in_its_token() {
        let (sink_a, _rx_a) = sink();
        let (sink_b, _rx_b) = sink();
        let first = host_session("127.0.0.1", participant("ada"), sink_a).expect("host");
        let second = host_session("127.0.0.1", participant("ada"), sink_b).expect("host");

        let (_, _, _, key_a) = parse_token(&first.info.token).expect("token");
        let (_, _, _, key_b) = parse_token(&second.info.token).expect("token");
        assert_ne!(
            key_a, key_b,
            "a session key is scoped to its session, so one token never speaks for another"
        );
    }

    #[test]
    fn a_relay_publishes_its_public_key_in_its_endpoint() {
        let relay = run_relay("127.0.0.1").expect("relay");
        let (_, key_hex) = relay
            .endpoint
            .split_once('/')
            .expect("endpoint carries a key");
        assert!(
            decode_public_key(key_hex).is_some(),
            "an operator hands this string out; it has to carry what a participant must pin: {}",
            relay.endpoint
        );
    }

    #[test]
    fn a_relay_address_without_a_pinned_key_is_refused() {
        let relay = run_relay("127.0.0.1").expect("relay");
        let (authority, _) = relay.endpoint.split_once('/').expect("endpoint");

        let (guest_sink, _rx) = sink();
        let err = create_via_relay(authority, participant("ada"), guest_sink).unwrap_err();
        assert!(
            err.contains("public-key"),
            "an unpinned relay is whoever answered, so it is refused rather than dialled: {err}"
        );
    }

    #[test]
    fn a_generated_secret_is_128_bits_of_hex_and_never_repeats() {
        let a = new_secret();
        let b = new_secret();
        assert_eq!(a.len(), SECRET_HEX_LEN);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
        assert_ne!(a, b, "a session token must not be guessable from another");
    }

    // --- over the wire --------------------------------------------------------------------------

    struct ChannelSink(Mutex<Sender<ServerFrame>>);

    impl LocalSink for ChannelSink {
        fn deliver(&self, frame: ServerFrame) {
            let _ = lock(&self.0).send(frame);
        }
    }

    fn sink() -> (Arc<dyn LocalSink>, Receiver<ServerFrame>) {
        let (tx, rx) = mpsc::channel();
        (Arc::new(ChannelSink(Mutex::new(tx))), rx)
    }

    fn next(rx: &Receiver<ServerFrame>) -> ServerFrame {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("a frame from the broker")
    }

    #[test]
    fn a_hosted_session_round_trips_updates_between_two_participants() {
        let (host_sink, host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        assert!(hosted.info.authority, "the creator owns the document");

        let (guest_sink, guest_rx) = sink();
        let guest =
            join_session(&hosted.info.token, participant("grace"), guest_sink).expect("join");
        assert!(!guest.info.authority, "a joiner never owns the document");
        assert_eq!(guest.info.session_id, hosted.info.session_id);

        assert_eq!(
            next(&guest_rx),
            ServerFrame::PeerJoin {
                peer: participant("ada")
            },
            "the joiner is told who is already in the room"
        );
        assert_eq!(
            next(&host_rx),
            ServerFrame::PeerJoin {
                peer: participant("grace")
            }
        );

        hosted.send_update(vec![7, 8, 9]);
        assert_eq!(
            next(&guest_rx),
            ServerFrame::Update {
                update: vec![7, 8, 9]
            }
        );

        guest.send_update(vec![1, 2]);
        assert_eq!(next(&host_rx), ServerFrame::Update { update: vec![1, 2] });
    }

    #[test]
    fn presence_over_the_wire_is_restamped_with_the_senders_identity() {
        let (host_sink, host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let (guest_sink, _guest_rx) = sink();
        let guest =
            join_session(&hosted.info.token, participant("grace"), guest_sink).expect("join");

        // The guest holds the token, so it can address a frame as anyone — including as the host.
        guest.send_presence(Presence {
            participant_id: "ada".into(),
            display_name: "Ada".into(),
            color: "#000000".into(),
            cursor: 4,
            selection: Vec::new(),
        });

        assert_eq!(
            next(&host_rx),
            ServerFrame::PeerJoin {
                peer: participant("grace")
            }
        );
        assert_eq!(
            next(&host_rx),
            ServerFrame::Presence {
                presence: presence_of("grace", 4)
            },
            "a peer can only ever speak as the identity it was admitted under"
        );
    }

    #[test]
    fn a_join_with_the_wrong_token_is_refused() {
        let (host_sink, _host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let (_, port, _, broker_key) = parse_token(&hosted.info.token).expect("token");

        let (guest_sink, _guest_rx) = sink();
        let wrong = format_token(
            "127.0.0.1",
            port,
            &"b".repeat(SECRET_HEX_LEN),
            &encode_hex(&broker_key),
        );
        let err = join_session(&wrong, participant("grace"), guest_sink).unwrap_err();

        assert_eq!(err, BrokerError::UnknownSession.message());
    }

    #[test]
    fn a_hosted_session_refuses_a_create_frame_from_the_wire() {
        let (host_sink, _host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let (_, port, _, broker_key) = parse_token(&hosted.info.token).expect("token");

        // Reaching someone's listener must not let you open a session on their machine — only a
        // relay honours `Create`. The attacker here holds the token, so it gets through the Noise
        // handshake: encryption keeps strangers out, not invitees.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        let transport = handshake_initiator(&mut stream, &broker_key).expect("handshake");
        let read_stream = stream.try_clone().expect("clone");
        let (mut reader, mut writer) = split(&transport, read_stream, stream);
        write_frame(
            &mut writer,
            &ClientFrame::Create {
                identity: participant("mallory"),
            },
        )
        .expect("write");

        let reply: Option<ServerFrame> = read_frame(&mut reader).expect("read");
        assert!(
            matches!(reply, Some(ServerFrame::Rejected { .. })),
            "expected a rejection, got {reply:?}"
        );
    }

    #[test]
    fn a_peer_that_cannot_complete_the_handshake_never_reaches_the_broker() {
        let (host_sink, _host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let (_, port, secret, _) = parse_token(&hosted.info.token).expect("token");

        // Exactly what a pre-#1811 client did: a length-prefixed JSON join frame straight onto the
        // socket, secret and all. There is no longer anything at the other end that will read it.
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
        write_frame(
            &mut stream,
            &ClientFrame::Join {
                secret: secret.clone(),
                identity: participant("grace"),
            },
        )
        .expect("write");
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .expect("timeout");

        let mut byte = [0u8; 1];
        assert!(
            matches!(stream.read(&mut byte), Ok(0) | Err(_)),
            "an unencrypted peer is hung up on without an answer"
        );
        assert_eq!(
            lock(&hosted.hub.broker).member_count(&secret),
            1,
            "and it was never admitted to the session"
        );
    }

    #[test]
    fn a_joiner_whose_token_pins_the_wrong_key_cannot_connect() {
        let (host_sink, _host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let (_, port, secret, _) = parse_token(&hosted.info.token).expect("token");

        // The shape of a machine-in-the-middle: right endpoint, right secret, somebody else's key.
        let impostor = StaticKeypair::generate().expect("keypair");
        let forged = format_token("127.0.0.1", port, &secret, &impostor.public_hex());

        let (guest_sink, _guest_rx) = sink();
        let err = join_session(&forged, participant("grace"), guest_sink).unwrap_err();

        assert!(
            err.contains("encrypted channel"),
            "the pin is what makes the token more than a password: {err}"
        );
        assert_eq!(
            lock(&hosted.hub.broker).member_count(&secret),
            1,
            "and nobody was admitted"
        );
    }

    /// Does `haystack` contain `needle` anywhere?
    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        !needle.is_empty()
            && haystack.len() >= needle.len()
            && haystack.windows(needle.len()).any(|w| w == needle)
    }

    fn pump(mut from: TcpStream, mut to: TcpStream, seen: Arc<Mutex<Vec<u8>>>) {
        let mut buf = [0u8; 4096];
        loop {
            match from.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    lock(&seen).extend_from_slice(&buf[..n]);
                    if to.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = to.shutdown(Shutdown::Both);
    }

    /// A tap on the wire: it forwards every byte between a joiner and the broker and keeps a copy.
    /// This is the person on the workshop wifi that ADR 0016 could only mitigate by defaulting to
    /// loopback. Returns the port to dial and the bytes it collected.
    fn tapped_path(target_port: u16) -> (u16, Arc<Mutex<Vec<u8>>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let seen = Arc::new(Mutex::new(Vec::new()));

        let recorded = Arc::clone(&seen);
        thread::spawn(move || {
            let Ok((client, _)) = listener.accept() else {
                return;
            };
            let Ok(upstream) = TcpStream::connect(("127.0.0.1", target_port)) else {
                return;
            };
            let (Ok(client_read), Ok(upstream_write)) = (client.try_clone(), upstream.try_clone())
            else {
                return;
            };
            let outbound = {
                let recorded = Arc::clone(&recorded);
                thread::spawn(move || pump(client_read, upstream_write, recorded))
            };
            pump(upstream, client, recorded);
            let _ = outbound.join();
        });

        (port, seen)
    }

    #[test]
    fn an_eavesdropper_on_the_path_reads_neither_the_join_secret_nor_the_document() {
        let (host_sink, host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let (_, port, secret, broker_key) = parse_token(&hosted.info.token).expect("token");

        // The joiner dials the tap while still pinning the real broker's key — passing bytes through
        // unchanged is precisely what an attacker on the path can do without being noticed.
        let (tap_port, tapped) = tapped_path(port);
        let token = format_token("127.0.0.1", tap_port, &secret, &encode_hex(&broker_key));
        let (guest_sink, guest_rx) = sink();
        let guest = join_session(&token, participant("grace"), guest_sink).expect("join");

        assert_eq!(
            next(&guest_rx),
            ServerFrame::PeerJoin {
                peer: participant("ada")
            }
        );
        assert_eq!(
            next(&host_rx),
            ServerFrame::PeerJoin {
                peer: participant("grace")
            }
        );
        let model = b"aggregate Order { invariant total_is_positive: total > 0 }".to_vec();
        hosted.send_update(model.clone());
        assert_eq!(
            next(&guest_rx),
            ServerFrame::Update {
                update: model.clone()
            },
            "the session works through the tap, so everything below really did cross it"
        );

        let seen = lock(&tapped).clone();
        assert!(
            seen.len() > 100,
            "the tap recorded the conversation: {} bytes",
            seen.len()
        );
        assert!(
            !contains(&seen, secret.as_bytes()),
            "the join token grants edit access to the model — lifting it off the wire must not work"
        );
        assert!(
            !contains(&seen, &model),
            "the domain model must not be readable by whoever shares the wifi"
        );
        assert!(!contains(&seen, b"grace display"), "nor who is in the room");
        drop(guest);
    }

    #[test]
    fn the_authority_leaving_tells_the_guest_and_takes_the_session_with_it() {
        let (host_sink, _host_rx) = sink();
        let mut hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let token = hosted.info.token.clone();
        let (guest_sink, guest_rx) = sink();
        let _guest = join_session(&token, participant("grace"), guest_sink).expect("join");
        assert_eq!(
            next(&guest_rx),
            ServerFrame::PeerJoin {
                peer: participant("ada")
            }
        );

        hosted.stop();

        assert_eq!(
            next(&guest_rx),
            ServerFrame::PeerLeave {
                participant_id: "ada".into()
            }
        );
        let (late_sink, _late_rx) = sink();
        assert!(
            join_session(&token, participant("late"), late_sink).is_err(),
            "the session — and its token — died with the authority"
        );
    }

    #[test]
    fn a_dead_broker_retracts_the_peers_it_was_relaying() {
        let (host_sink, _host_rx) = sink();
        let hosted = host_session("127.0.0.1", participant("ada"), host_sink).expect("host");
        let (guest_sink, guest_rx) = sink();
        let _guest =
            join_session(&hosted.info.token, participant("grace"), guest_sink).expect("join");
        assert_eq!(
            next(&guest_rx),
            ServerFrame::PeerJoin {
                peer: participant("ada")
            }
        );

        // Hard drop: no graceful PeerLeave is sent, the socket simply dies.
        hosted.hub.close_all();
        hosted.shutdown.store(true, Ordering::SeqCst);

        assert_eq!(
            next(&guest_rx),
            ServerFrame::PeerLeave {
                participant_id: "ada".into()
            },
            "a caret must not be left frozen on screen when the broker vanishes"
        );
    }

    /// A broker under the attacker's control: it answers the admission however the test says, then
    /// pushes whatever follow-up frames it likes. This is the threat model of an invitation link.
    ///
    /// Note what encryption does NOT do here, and why the client-side checks these tests pin are
    /// still load-bearing: this broker mints its own keypair and puts it in the token it hands out,
    /// so the Noise handshake completes perfectly. Pinning proves you reached *the broker named in
    /// the token* — it says nothing about whether the person who sent you that token is honest.
    fn hostile_broker(reply: ServerFrame, follow_up: Vec<ServerFrame>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let keypair = StaticKeypair::generate().expect("keypair");
        let public_key = keypair.public_hex();

        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let Ok(transport) = handshake_responder(&mut stream, &keypair) else {
                    return;
                };
                let Ok(read_stream) = stream.try_clone() else {
                    return;
                };
                let (mut reader, mut writer) = split(&transport, read_stream, stream);
                let _: Option<ClientFrame> = read_frame(&mut reader).ok().flatten();
                let _ = write_frame(&mut writer, &reply);
                for frame in &follow_up {
                    let _ = write_frame(&mut writer, frame);
                }
                thread::sleep(Duration::from_millis(250));
            }
        });
        (
            format_token("127.0.0.1", port, &"a".repeat(SECRET_HEX_LEN), &public_key),
            handle,
        )
    }

    #[test]
    fn a_broker_that_calls_a_joiner_the_authority_is_not_believed() {
        let (token, broker) = hostile_broker(
            ServerFrame::Admitted {
                session_id: "s1".into(),
                authority: true,
                admitted_as: participant("grace"),
                secret: None,
            },
            Vec::new(),
        );
        let (guest_sink, _rx) = sink();
        let session = join_session(&token, participant("grace"), guest_sink).expect("join");

        // We asked to JOIN. Believing the answer would make this editor seed the shared document from
        // its own buffer and broadcast it — an invitation link that exfiltrates the model.
        assert!(!session.info.authority);
        drop(session);
        let _ = broker.join();
    }

    #[test]
    fn a_hostile_identity_from_the_broker_never_reaches_the_editor() {
        let malicious = Participant {
            id: "mallory".into(),
            display_name: "Mallory".into(),
            // Breaks out of `--koi-presence-color: <colour>` into arbitrary declarations.
            color: "red;background-image:url(http://evil.example/p)".into(),
        };
        let (token, broker) = hostile_broker(
            ServerFrame::Admitted {
                session_id: "s1".into(),
                authority: false,
                admitted_as: participant("grace"),
                secret: None,
            },
            vec![
                ServerFrame::PeerJoin { peer: malicious },
                ServerFrame::PeerJoin {
                    peer: participant("ada"),
                },
            ],
        );
        let (guest_sink, rx) = sink();
        let session = join_session(&token, participant("grace"), guest_sink).expect("join");

        assert_eq!(
            next(&rx),
            ServerFrame::PeerJoin {
                peer: participant("ada")
            },
            "the hostile frame was dropped and the honest one still got through"
        );
        drop(session);
        let _ = broker.join();
    }

    #[test]
    fn a_relay_brokers_a_session_for_participants_that_host_nothing() {
        let relay = run_relay("127.0.0.1").expect("relay");

        let (creator_sink, creator_rx) = sink();
        let creator =
            create_via_relay(&relay.endpoint, participant("ada"), creator_sink).expect("create");
        assert!(
            creator.info.authority,
            "whoever opened the session owns the document, even on a relay"
        );
        assert_eq!(
            parse_token(&creator.info.token).map(|(_, _, s, _)| s.len()),
            Some(SECRET_HEX_LEN),
            "the relay minted a real join token: {}",
            creator.info.session_id
        );

        let (guest_sink, guest_rx) = sink();
        let guest =
            join_session(&creator.info.token, participant("grace"), guest_sink).expect("join");
        assert!(!guest.info.authority);

        assert_eq!(
            next(&guest_rx),
            ServerFrame::PeerJoin {
                peer: participant("ada")
            }
        );
        assert_eq!(
            next(&creator_rx),
            ServerFrame::PeerJoin {
                peer: participant("grace")
            }
        );

        creator.send_update(vec![42]);
        assert_eq!(next(&guest_rx), ServerFrame::Update { update: vec![42] });
        guest.send_update(vec![43]);
        assert_eq!(next(&creator_rx), ServerFrame::Update { update: vec![43] });
    }

    #[test]
    fn a_relay_refuses_a_joiner_presenting_the_creators_identity() {
        let relay = run_relay("127.0.0.1").expect("relay");
        let (creator_sink, _creator_rx) = sink();
        let creator =
            create_via_relay(&relay.endpoint, participant("ada"), creator_sink).expect("create");

        let (impostor_sink, _impostor_rx) = sink();
        let err = join_session(&creator.info.token, participant("ada"), impostor_sink).unwrap_err();

        assert_eq!(err, BrokerError::DuplicateIdentity.message());
    }

    #[test]
    fn secrets_are_compared_on_content_and_length() {
        let secret = "a".repeat(SECRET_HEX_LEN);
        assert!(secrets_match(&secret, &secret));
        assert!(!secrets_match(&secret, &"a".repeat(SECRET_HEX_LEN - 1)));
        assert!(!secrets_match(
            &secret,
            &format!("{}b", "a".repeat(SECRET_HEX_LEN - 1))
        ));
        assert!(!secrets_match("", ""), "an empty secret never matches");
    }
}
