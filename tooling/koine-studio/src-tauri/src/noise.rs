// Koine Studio — the encrypted transport under the collaboration broker (#1811, ADR 0017).
//
// ADR 0016 shipped the broker over plain TCP and said so out loud: on loopback that is moot, but the
// moment someone sets `collab.bindAddress` to a LAN address to run an actual workshop — the feature's
// whole point — the domain model, everyone's identity and cursor, and the join secret itself all cross
// the network in cleartext. This module is the answer, and it is unconditional: there is no plaintext
// code path left to fall back to, so there is no downgrade to negotiate and nothing for a user to
// remember.
//
// WHAT IT IS. One Noise handshake per connection, pattern
// `Noise_NK_25519_ChaChaPoly_BLAKE2s`, from `snow` — a vetted implementation of a vetted protocol,
// rather than anything hand-rolled here. `NK` means:
//
//   * **N** — the initiator has no static key. It stays anonymous at the crypto layer, which is the
//     honest description of what it is: whoever holds the join token. Authenticating *people* would
//     need an account system this product does not have (ADR 0016), so the bearer secret remains the
//     credential — it is simply carried inside the tunnel now instead of in the clear on frame one.
//   * **K** — the responder's static public key is **known to the initiator in advance**. It travels
//     in the join token, which the host already has to hand over out-of-band. Pinning it there means
//     no CA, no trust prompt, and no machine-in-the-middle: an attacker who can rewrite traffic still
//     cannot answer for a broker whose key it does not hold.
//
// Two consequences worth stating plainly, because they are what make this worth the dependency:
//
//   1. For a hosted session, the key is **token-scoped**. An initiator has to know it to even form the
//      first handshake message, so a stranger who scanned the port cannot get a reply out of the
//      broker at all — the listener is silent rather than merely uninformative.
//   2. Both handshake messages carry ephemeral keys (`-> e, es` then `<- e, ee`), so the session keys
//      are **forward-secret**: traffic recorded today stays unreadable even if the join token leaks
//      tomorrow.
//
// WHAT IT IS NOT. It is hop-by-hop to the broker, not end-to-end between participants — a relay
// terminates the encryption because it has to read frames to fan them out. ADR 0017 has the full
// threat model, including what this deliberately does not defend.
//
// THE `&self` DETAIL THAT SHAPES THE API. The broker's socket layer hands a *writer* to a shared,
// mutex-guarded table and keeps a *reader* on the connection thread; a cipher state that needed
// `&mut` from both would deadlock the moment the reader blocked while holding the lock. So this uses
// snow's `StatelessTransportState`, whose `read_message`/`write_message` take `&self` plus an explicit
// nonce — one handshake, an `Arc` shared by both halves, and a per-direction counter each.

use std::io::{self, Read, Write};
use std::sync::Arc;

use snow::{Builder, StatelessTransportState};

/// The one handshake pattern and cipher suite this transport speaks. There is no negotiation: a peer
/// either speaks exactly this or is dropped, which is one fewer thing an attacker can talk us out of.
pub const NOISE_PATTERN: &str = "Noise_NK_25519_ChaChaPoly_BLAKE2s";

/// Mixed into the handshake hash by both sides. Domain separation, so a transcript from some other
/// protocol that happens to use the same pattern can never be replayed at this one.
pub const NOISE_PROLOGUE: &[u8] = b"koine-collab/1";

/// An X25519 public key, in bytes and as it appears hex-encoded in a join token.
pub const PUBLIC_KEY_BYTES: usize = 32;
pub const PUBLIC_KEY_HEX_LEN: usize = PUBLIC_KEY_BYTES * 2;

/// Noise caps one transport message at 65535 bytes *including* the 16-byte AEAD tag, so a payload
/// larger than that is split across several — see `NoiseWriter`.
const MAX_NOISE_MESSAGE: usize = 65535;
const TAG_LEN: usize = 16;
pub const MAX_CHUNK_PLAINTEXT: usize = MAX_NOISE_MESSAGE - TAG_LEN;

/// Handshake messages in this pattern are 48 and 48 bytes. The bound is generous and exists only so a
/// peer cannot make us allocate by declaring a large one.
const MAX_HANDSHAKE_MESSAGE: usize = 1024;

/// A responder's long-term-for-a-session X25519 identity. A hosted session mints one per session and
/// publishes its public half in the join token; a relay mints one at startup and publishes it in its
/// endpoint string. Nothing outlives the process, so there is no key file to protect or rotate.
pub struct StaticKeypair {
    private: Vec<u8>,
    public: Vec<u8>,
}

impl StaticKeypair {
    pub fn generate() -> io::Result<Self> {
        let keypair = builder().generate_keypair().map_err(crypto_error)?;
        Ok(StaticKeypair {
            private: keypair.private,
            public: keypair.public,
        })
    }

    /// The public half, hex-encoded — the form that goes into a join token.
    pub fn public_hex(&self) -> String {
        encode_hex(&self.public)
    }
}

// A private key is a secret, so keep it out of any `{:?}` that might reach a log line.
impl std::fmt::Debug for StaticKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StaticKeypair")
            .field("public", &self.public_hex())
            .finish_non_exhaustive()
    }
}

fn builder<'a>() -> Builder<'a> {
    // The pattern string is a compile-time constant of this crate, so a parse failure would be a bug
    // here rather than anything a peer can cause.
    Builder::new(
        NOISE_PATTERN
            .parse()
            .expect("the Noise pattern is a constant of this crate"),
    )
}

fn crypto_error(err: snow::Error) -> io::Error {
    // Deliberately not `{err}` from a peer-triggered path — see `handshake_*`, which flattens every
    // failure to one message. This one carries detail because it only fires on local key generation.
    io::Error::other(format!("collaboration transport crypto failure: {err}"))
}

/// Every way a handshake can fail — a peer speaking plain TCP, a peer with the wrong key, a truncated
/// message, a tampered one — collapses to this. Distinguishing them would tell an unauthenticated
/// caller which of its guesses was closer.
fn handshake_failed() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "the collaboration transport handshake failed",
    )
}

// --- hex ------------------------------------------------------------------------------------------

pub fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut hex, b| {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
        hex
    })
}

/// Parse a hex-encoded X25519 public key. Strict: exactly 64 lowercase hex characters, because this
/// comes out of a token a stranger may have composed.
pub fn decode_public_key(hex: &str) -> Option<[u8; PUBLIC_KEY_BYTES]> {
    if hex.len() != PUBLIC_KEY_HEX_LEN
        || !hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return None;
    }
    let mut out = [0u8; PUBLIC_KEY_BYTES];
    for (byte, pair) in out.iter_mut().zip(hex.as_bytes().chunks_exact(2)) {
        let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        *byte = (digit(pair[0])? << 4) | digit(pair[1])?;
    }
    Some(out)
}

// --- handshake ------------------------------------------------------------------------------------

/// A handshake message: a 2-byte big-endian length and that many bytes.
fn write_handshake<W: Write>(w: &mut W, message: &[u8]) -> io::Result<()> {
    if message.is_empty() || message.len() > MAX_HANDSHAKE_MESSAGE {
        return Err(handshake_failed());
    }
    w.write_all(&(message.len() as u16).to_be_bytes())?;
    w.write_all(message)?;
    w.flush()
}

fn read_handshake<R: Read>(r: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0u8; 2];
    r.read_exact(&mut header).map_err(|_| handshake_failed())?;
    let len = u16::from_be_bytes(header) as usize;
    // Bound BEFORE allocating: the length is the very first thing an unauthenticated peer controls.
    if len == 0 || len > MAX_HANDSHAKE_MESSAGE {
        return Err(handshake_failed());
    }
    let mut message = vec![0u8; len];
    r.read_exact(&mut message).map_err(|_| handshake_failed())?;
    Ok(message)
}

/// Dial a broker whose static public key is already known — from a join token, or from the relay
/// address the user configured. `-> e, es` out, `<- e, ee` back.
pub fn handshake_initiator<S: Read + Write>(
    stream: &mut S,
    remote_public: &[u8],
) -> io::Result<Arc<StatelessTransportState>> {
    let mut handshake = builder()
        .prologue(NOISE_PROLOGUE)
        .and_then(|b| b.remote_public_key(remote_public))
        .and_then(|b| b.build_initiator())
        .map_err(|_| handshake_failed())?;

    let mut scratch = [0u8; MAX_HANDSHAKE_MESSAGE];
    let written = handshake
        .write_message(&[], &mut scratch)
        .map_err(|_| handshake_failed())?;
    write_handshake(stream, &scratch[..written])?;

    let reply = read_handshake(stream)?;
    handshake
        .read_message(&reply, &mut scratch)
        .map_err(|_| handshake_failed())?;

    finish(handshake)
}

/// Answer a dialler. Fails — silently, from the caller's point of view — for anyone who does not
/// already hold this responder's public key, which for a hosted session means anyone without the
/// join token.
pub fn handshake_responder<S: Read + Write>(
    stream: &mut S,
    keypair: &StaticKeypair,
) -> io::Result<Arc<StatelessTransportState>> {
    let mut handshake = builder()
        .prologue(NOISE_PROLOGUE)
        .and_then(|b| b.local_private_key(&keypair.private))
        .and_then(|b| b.build_responder())
        .map_err(|_| handshake_failed())?;

    let mut scratch = [0u8; MAX_HANDSHAKE_MESSAGE];
    let hello = read_handshake(stream)?;
    handshake
        .read_message(&hello, &mut scratch)
        .map_err(|_| handshake_failed())?;

    let written = handshake
        .write_message(&[], &mut scratch)
        .map_err(|_| handshake_failed())?;
    write_handshake(stream, &scratch[..written])?;

    finish(handshake)
}

fn finish(handshake: snow::HandshakeState) -> io::Result<Arc<StatelessTransportState>> {
    if !handshake.is_handshake_finished() {
        return Err(handshake_failed());
    }
    handshake
        .into_stateless_transport_mode()
        .map(Arc::new)
        .map_err(|_| handshake_failed())
}

/// Build the two halves of an established channel over an already-split socket. `read` and `write`
/// must be the two ends of the *same* connection the handshake ran on.
pub fn split<R: Read, W: Write>(
    transport: &Arc<StatelessTransportState>,
    read: R,
    write: W,
) -> (NoiseReader<R>, NoiseWriter<W>) {
    (
        NoiseReader {
            inner: read,
            transport: Arc::clone(transport),
            nonce: 0,
            buffer: Vec::new(),
            position: 0,
        },
        NoiseWriter {
            inner: write,
            transport: Arc::clone(transport),
            nonce: 0,
        },
    )
}

// --- the established channel ----------------------------------------------------------------------

/// The sending half. `Write`, so the broker's existing length-prefixed JSON codec (`write_frame`)
/// stacks straight on top of it and the frame format did not have to change to gain encryption.
///
/// On the wire each call emits `[2-byte big-endian ciphertext length][ciphertext]`, one Noise
/// transport message, chunked at the protocol's 65535-byte ceiling.
#[derive(Debug)]
pub struct NoiseWriter<W: Write> {
    inner: W,
    transport: Arc<StatelessTransportState>,
    /// This direction's message counter. It is never transmitted — the peer counts too, so a dropped,
    /// duplicated or reordered chunk simply fails to authenticate.
    nonce: u64,
}

impl<W: Write> Write for NoiseWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let take = buf.len().min(MAX_CHUNK_PLAINTEXT);
        let mut ciphertext = vec![0u8; take + TAG_LEN];
        let written = self
            .transport
            .write_message(self.nonce, &buf[..take], &mut ciphertext)
            .map_err(|_| io::Error::other("could not encrypt a collaboration frame"))?;
        self.nonce = self
            .nonce
            .checked_add(1)
            .ok_or_else(|| io::Error::other("the collaboration transport is exhausted"))?;

        self.inner.write_all(&(written as u16).to_be_bytes())?;
        self.inner.write_all(&ciphertext[..written])?;
        Ok(take)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// The receiving half. `Read`, so `read_frame` stacks on top unchanged.
///
/// A chunk that does not authenticate — tampered, replayed, reordered, or from someone who is not the
/// peer we handshook with — is an error, never a partial delivery.
#[derive(Debug)]
pub struct NoiseReader<R: Read> {
    inner: R,
    transport: Arc<StatelessTransportState>,
    nonce: u64,
    /// The plaintext of the chunk currently being handed out, and how far through it we are.
    buffer: Vec<u8>,
    position: usize,
}

impl<R: Read> NoiseReader<R> {
    /// Decrypt the next chunk into `buffer`. `Ok(0)` means a clean end of stream *between* chunks —
    /// which is what lets `read_frame`'s "nothing at all yet means the peer hung up" case survive the
    /// extra layer.
    fn fill(&mut self) -> io::Result<usize> {
        let mut header = [0u8; 2];
        let mut filled = 0;
        while filled < header.len() {
            match self.inner.read(&mut header[filled..]) {
                Ok(0) if filled == 0 => return Ok(0),
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "encrypted collaboration chunk header truncated",
                    ))
                }
                Ok(n) => filled += n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }

        let len = u16::from_be_bytes(header) as usize;
        // An empty plaintext would decrypt to zero bytes and read exactly like a clean hang-up, so it
        // is refused outright rather than left as a way to fake one. `<= TAG_LEN` covers that and the
        // tag-only/truncated cases together.
        if len <= TAG_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "encrypted collaboration chunk is too short to be authentic",
            ));
        }
        let mut ciphertext = vec![0u8; len];
        self.inner.read_exact(&mut ciphertext)?;

        let mut plaintext = vec![0u8; len - TAG_LEN];
        let decrypted = self
            .transport
            .read_message(self.nonce, &ciphertext, &mut plaintext)
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "an unauthentic frame arrived on the collaboration transport",
                )
            })?;
        self.nonce = self
            .nonce
            .checked_add(1)
            .ok_or_else(|| io::Error::other("the collaboration transport is exhausted"))?;

        plaintext.truncate(decrypted);
        self.buffer = plaintext;
        self.position = 0;
        Ok(decrypted)
    }
}

impl<R: Read> Read for NoiseReader<R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }
        if self.position == self.buffer.len() && self.fill()? == 0 {
            return Ok(0);
        }
        let take = (self.buffer.len() - self.position).min(out.len());
        out[..take].copy_from_slice(&self.buffer[self.position..self.position + take]);
        self.position += take;
        Ok(take)
    }
}

// --- tests ------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    /// Two ends of one real loopback connection — the handshake is a conversation, so it needs one.
    fn connected_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let dialer =
            thread::spawn(move || TcpStream::connect(("127.0.0.1", port)).expect("connect"));
        let (accepted, _) = listener.accept().expect("accept");
        (dialer.join().expect("dial"), accepted)
    }

    /// A completed handshake, as (initiator transport, responder transport).
    fn transport_pair() -> (Arc<StatelessTransportState>, Arc<StatelessTransportState>) {
        let keypair = StaticKeypair::generate().expect("keypair");
        let public = keypair.public.clone();
        let (mut client, mut server) = connected_pair();

        let responder = thread::spawn(move || {
            handshake_responder(&mut server, &keypair).expect("responder handshake")
        });
        let initiator = handshake_initiator(&mut client, &public).expect("initiator handshake");
        (initiator, responder.join().expect("responder thread"))
    }

    // --- handshake ----------------------------------------------------------------------------

    #[test]
    fn a_handshake_establishes_a_channel_that_round_trips_in_both_directions() {
        let (initiator, responder) = transport_pair();

        let mut wire = Vec::new();
        let (_, mut writer) = split(&initiator, Cursor::new(Vec::new()), &mut wire);
        writer.write_all(b"the model").expect("write");
        drop(writer);
        let (mut reader, _) = split(&responder, Cursor::new(wire), Vec::new());
        let mut got = Vec::new();
        reader.read_to_end(&mut got).expect("read");
        assert_eq!(got, b"the model");

        // And back the other way: each direction has its own cipher state and its own nonce run.
        let mut back = Vec::new();
        let (_, mut writer) = split(&responder, Cursor::new(Vec::new()), &mut back);
        writer.write_all(b"acknowledged").expect("write");
        drop(writer);
        let (mut reader, _) = split(&initiator, Cursor::new(back), Vec::new());
        let mut got = Vec::new();
        reader.read_to_end(&mut got).expect("read");
        assert_eq!(got, b"acknowledged");
    }

    #[test]
    fn an_initiator_dialling_with_the_wrong_public_key_cannot_complete_the_handshake() {
        let keypair = StaticKeypair::generate().expect("keypair");
        let impostor = StaticKeypair::generate().expect("keypair");
        let wrong_public = impostor.public.clone();
        let (mut client, mut server) = connected_pair();

        let responder =
            thread::spawn(move || handshake_responder(&mut server, &keypair).map(|_| ()));
        let outcome = handshake_initiator(&mut client, &wrong_public);

        assert!(
            outcome.is_err(),
            "a broker's key is pinned in the join token; a machine-in-the-middle holds someone else's"
        );
        assert!(
            responder.join().expect("responder thread").is_err(),
            "and the broker learns nothing from the attempt either"
        );
    }

    #[test]
    fn a_peer_speaking_plain_tcp_is_refused_rather_than_admitted() {
        let keypair = StaticKeypair::generate().expect("keypair");
        let (mut client, mut server) = connected_pair();

        let responder =
            thread::spawn(move || handshake_responder(&mut server, &keypair).map(|_| ()));
        // Exactly what the pre-#1811 client sent first: a 4-byte length and a JSON join frame.
        let body = br#"{"type":"join","secret":"aaaa"}"#;
        client
            .write_all(&(body.len() as u32).to_be_bytes())
            .expect("write");
        client.write_all(body).expect("write");

        assert!(
            responder.join().expect("responder thread").is_err(),
            "there is no plaintext code path left to fall back to"
        );
    }

    #[test]
    fn a_handshake_message_longer_than_the_bound_is_refused_before_allocating() {
        let mut wire = Cursor::new(u16::MAX.to_be_bytes().to_vec());
        assert!(read_handshake(&mut wire).is_err());
    }

    // --- the established channel --------------------------------------------------------------

    #[test]
    fn a_payload_larger_than_one_noise_message_is_chunked_and_reassembled() {
        let (initiator, responder) = transport_pair();
        // Three chunks and a bit: the Noise protocol caps one message at 65535 bytes, and a `.koi`
        // model plus a burst of CRDT updates can exceed that.
        let payload: Vec<u8> = (0..MAX_CHUNK_PLAINTEXT * 3 + 17)
            .map(|i| (i % 251) as u8)
            .collect();

        let mut wire = Vec::new();
        let (_, mut writer) = split(&initiator, Cursor::new(Vec::new()), &mut wire);
        writer.write_all(&payload).expect("write");
        drop(writer);

        let (mut reader, _) = split(&responder, Cursor::new(wire), Vec::new());
        let mut got = Vec::new();
        reader.read_to_end(&mut got).expect("read");
        assert_eq!(got, payload);
    }

    #[test]
    fn a_tampered_byte_is_refused_rather_than_delivered() {
        let (initiator, responder) = transport_pair();
        let mut wire = Vec::new();
        let (_, mut writer) = split(&initiator, Cursor::new(Vec::new()), &mut wire);
        writer.write_all(b"an honest update").expect("write");
        drop(writer);

        // Flip a bit in the ciphertext, past the 2-byte length header.
        wire[5] ^= 0x01;

        let (mut reader, _) = split(&responder, Cursor::new(wire), Vec::new());
        let mut got = Vec::new();
        let err = reader.read_to_end(&mut got).expect_err("must refuse");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(got.is_empty(), "nothing unauthentic is ever handed upwards");
    }

    #[test]
    fn a_replayed_chunk_is_refused_because_the_nonce_has_moved_on() {
        let (initiator, responder) = transport_pair();
        let mut wire = Vec::new();
        {
            let (_, mut writer) = split(&initiator, Cursor::new(Vec::new()), &mut wire);
            writer.write_all(b"first").expect("write");
            writer.write_all(b"second").expect("write");
        }
        let first_len = 2 + u16::from_be_bytes([wire[0], wire[1]]) as usize;
        let first = &wire[..first_len];

        // A recorder replays chunk one where chunk two belongs.
        let mut replayed = first.to_vec();
        replayed.extend_from_slice(first);

        let (mut reader, _) = split(&responder, Cursor::new(replayed), Vec::new());
        let mut got = Vec::new();
        let err = reader.read_to_end(&mut got).expect_err("must refuse");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert_eq!(got, b"first", "the honest first chunk still arrived");
    }

    #[test]
    fn a_chunk_too_short_to_carry_a_tag_is_refused() {
        let (_, responder) = transport_pair();
        // A length of exactly the tag would decrypt to zero bytes and read like a clean hang-up.
        let mut wire = (TAG_LEN as u16).to_be_bytes().to_vec();
        wire.extend_from_slice(&[0u8; TAG_LEN]);

        let (mut reader, _) = split(&responder, Cursor::new(wire), Vec::new());
        let mut got = Vec::new();
        let err = reader.read_to_end(&mut got).expect_err("must refuse");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn a_clean_end_of_stream_between_chunks_is_not_an_error() {
        let (_, responder) = transport_pair();
        let (mut reader, _) = split(&responder, Cursor::new(Vec::new()), Vec::new());
        let mut got = Vec::new();
        assert_eq!(reader.read_to_end(&mut got).expect("clean eof"), 0);
    }

    // --- keys ---------------------------------------------------------------------------------

    #[test]
    fn a_public_key_round_trips_through_hex_and_is_never_the_same_twice() {
        let a = StaticKeypair::generate().expect("keypair");
        let b = StaticKeypair::generate().expect("keypair");
        assert_eq!(a.public_hex().len(), PUBLIC_KEY_HEX_LEN);
        assert_ne!(
            a.public_hex(),
            b.public_hex(),
            "a session key must not be predictable from another's"
        );
        assert_eq!(
            decode_public_key(&a.public_hex()).map(|k| k.to_vec()),
            Some(a.public.clone())
        );
    }

    #[test]
    fn decoding_a_public_key_is_strict() {
        for bad in [
            String::new(),
            "0".repeat(PUBLIC_KEY_HEX_LEN - 1),
            "0".repeat(PUBLIC_KEY_HEX_LEN + 1),
            "z".repeat(PUBLIC_KEY_HEX_LEN),
            "A".repeat(PUBLIC_KEY_HEX_LEN),
        ] {
            assert!(decode_public_key(&bad).is_none(), "must reject {bad:?}");
        }
    }

    #[test]
    fn a_private_key_never_appears_in_a_debug_rendering() {
        let keypair = StaticKeypair::generate().expect("keypair");
        let rendered = format!("{keypair:?}");
        assert!(rendered.contains(&keypair.public_hex()));
        assert!(
            !rendered.contains(&encode_hex(&keypair.private)),
            "a private key must not be one careless log line away from disclosure"
        );
    }
}
