//! AMXC blob envelope — client-side AES-256-GCM encryption for OSS blobs.
//!
//! Two on-the-wire versions, both decodable by [`decrypt_blob`]:
//!
//! **v1** (uncompressed; what [`encrypt_blob`] writes):
//!   0: "AMXC" magic (4) · 4: version=1 (1) · 5: nonce (12) · 17: ciphertext
//!   ciphertext = AES-256-GCM(plaintext)
//!
//! **v2** (optional deflate; READ ONLY — nothing in the product writes it):
//!   0: "AMXC" magic (4) · 4: version=2 (1) · 5: flags (1) · 6: nonce (12) · 18: ciphertext
//!   ciphertext = AES-256-GCM(payload), where payload = deflate(plaintext) if
//!   `flags & FLAG_DEFLATE`, else plaintext. Compression is applied BEFORE
//!   encryption so it actually reduces blob/egress size; the flag is the only
//!   thing it leaks ("is this deflated"), which is not sensitive.
//!
//! `content_hash` (wire) = sha256(blob bytes); `plain_hash` (local) = sha256(plaintext).
//!
//! Both versions stay readable forever: team knowledge written before the move
//! to plaintext blobs is still in object storage, and this is the only way back
//! to it. The only writer left is the local secret store (team env
//! credentials), which uses v1.

use std::io::Read;
#[cfg(test)]
use std::io::Write;

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use flate2::read::DeflateDecoder;
// Writing deflate is test-only now; reading it is not (legacy v2 blobs).
#[cfg(test)]
use flate2::write::DeflateEncoder;
#[cfg(test)]
use flate2::Compression;
use sha2::{Digest, Sha256};

const MAGIC: &[u8; 4] = b"AMXC";
const VERSION_V1: u8 = 1;
const VERSION_V2: u8 = 2;
const NONCE_LEN: usize = 12;
const HEADER_LEN_V1: usize = 4 + 1 + NONCE_LEN; // 17
const HEADER_LEN_V2: usize = 4 + 1 + 1 + NONCE_LEN; // 18

/// `flags` bit: payload was deflate-compressed before encryption.
const FLAG_DEFLATE: u8 = 0x01;

/// Encrypt plaintext into a v1 (uncompressed) AMXC blob. Kept for callers that
/// must not depend on fleet-wide v2 support (e.g. the local secret store).
pub fn encrypt_blob(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let (nonce_bytes, ciphertext) = aes_encrypt(plaintext, key)?;
    let mut blob = Vec::with_capacity(HEADER_LEN_V1 + ciphertext.len());
    blob.extend_from_slice(MAGIC);
    blob.push(VERSION_V1);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Encrypt plaintext into a v2 AMXC blob, deflating the plaintext first when
/// that actually shrinks it.
///
/// Test-only: nothing writes v2 any more (knowledge content goes up as
/// plaintext), but blobs written by older daemons are still out there, so the
/// READ path must keep working — and testing a reader needs a writer.
#[cfg(test)]
pub fn encrypt_blob_compressed(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let mut flags = 0u8;
    let payload = match deflate(plaintext) {
        Ok(c) if c.len() < plaintext.len() => {
            flags |= FLAG_DEFLATE;
            c
        }
        // Compression failed or didn't help → store raw.
        _ => plaintext.to_vec(),
    };

    let (nonce_bytes, ciphertext) = aes_encrypt(&payload, key)?;
    let mut blob = Vec::with_capacity(HEADER_LEN_V2 + ciphertext.len());
    blob.extend_from_slice(MAGIC);
    blob.push(VERSION_V2);
    blob.push(flags);
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// Whether a blob carries the AMXC envelope, i.e. whether it needs a key at all.
///
/// Knowledge content is uploaded as PLAINTEXT (see `engine::prepare_upload`);
/// this is what lets a pull still read everything written before that change.
/// The version byte is checked as well as the magic so a document that happens
/// to begin with the four bytes `AMXC` is not mistaken for an envelope — it
/// would have to also carry 0x01 or 0x02 in its fifth byte to fool this.
pub fn is_encrypted_blob(bytes: &[u8]) -> bool {
    bytes.len() > HEADER_LEN_V1
        && &bytes[0..4] == MAGIC
        && matches!(bytes[4], VERSION_V1 | VERSION_V2)
}

/// Turn a blob fetched from object storage into file bytes.
///
/// The single entry point for every read path — the sync pull, the version
/// preview, the restore. Knowledge content is uploaded as plaintext, so most
/// blobs need nothing done to them; anything carrying the AMXC envelope was
/// written before that change and still needs the team key, which this device
/// may simply not have (the key is pasted by hand and nothing ever checked that
/// two members pasted the same one).
pub fn decode_blob(blob: Vec<u8>, key: Option<&[u8; 32]>) -> Result<Vec<u8>, String> {
    if !is_encrypted_blob(&blob) {
        return Ok(blob);
    }
    let key = key.ok_or_else(|| {
        "crypto: blob is encrypted but this device has no team secret to decrypt it".to_string()
    })?;
    decrypt_blob(&blob, key)
}

/// Decrypt an AMXC blob (v1 or v2), returning plaintext.
pub fn decrypt_blob(blob: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    if blob.len() < 5 {
        return Err(format!("crypto: blob too short: {} bytes", blob.len()));
    }
    if &blob[..4] != MAGIC {
        return Err(format!(
            "crypto: invalid magic: expected AMXC, got {:?}",
            &blob[..4]
        ));
    }
    match blob[4] {
        VERSION_V1 => {
            if blob.len() < HEADER_LEN_V1 {
                return Err(format!("crypto: v1 blob too short: {} bytes", blob.len()));
            }
            let nonce_bytes = &blob[5..17];
            let ciphertext = &blob[HEADER_LEN_V1..];
            aes_decrypt(nonce_bytes, ciphertext, key)
        }
        VERSION_V2 => {
            if blob.len() < HEADER_LEN_V2 {
                return Err(format!("crypto: v2 blob too short: {} bytes", blob.len()));
            }
            let flags = blob[5];
            let nonce_bytes = &blob[6..18];
            let ciphertext = &blob[HEADER_LEN_V2..];
            let payload = aes_decrypt(nonce_bytes, ciphertext, key)?;
            if flags & FLAG_DEFLATE != 0 {
                inflate(&payload)
            } else {
                Ok(payload)
            }
        }
        other => Err(format!(
            "crypto: unsupported version: expected 1 or 2, got {other}"
        )),
    }
}

/// sha256(bytes) → hex string
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex::encode(digest)
}

// ── internals ────────────────────────────────────────────────────────────────

fn aes_encrypt(payload: &[u8], key: &[u8; 32]) -> Result<([u8; NONCE_LEN], Vec<u8>), String> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce_bytes)
        .map_err(|e| format!("crypto: nonce generation failed: {e}"))?;
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("crypto: cipher init failed: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, payload)
        .map_err(|e| format!("crypto: AES-GCM encrypt failed: {e}"))?;
    Ok((nonce_bytes, ciphertext))
}

fn aes_decrypt(nonce_bytes: &[u8], ciphertext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| format!("crypto: cipher init failed: {e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("crypto: AES-GCM decrypt failed: {e}"))
}

/// Deflate-compress bytes. Test-only, with [`encrypt_blob_compressed`].
#[cfg(test)]
fn deflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data)
        .map_err(|e| format!("crypto: deflate failed: {e}"))?;
    enc.finish()
        .map_err(|e| format!("crypto: deflate failed: {e}"))
}

fn inflate(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    DeflateDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|e| format!("crypto: inflate failed: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_handles_both_shapes_and_refuses_to_guess() {
        let key = [7u8; 32];
        let plain = b"# note\n\njust text".to_vec();

        // What every new write looks like: no key involved.
        assert_eq!(decode_blob(plain.clone(), None).unwrap(), plain);
        assert_eq!(decode_blob(plain.clone(), Some(&key)).unwrap(), plain);

        // What is already in object storage.
        let envelope = encrypt_blob(&plain, &key).unwrap();
        assert_eq!(decode_blob(envelope.clone(), Some(&key)).unwrap(), plain);

        // No key, or the wrong one: an error, never ciphertext handed back as
        // if it were the document.
        assert!(decode_blob(envelope.clone(), None).is_err());
        assert!(decode_blob(envelope, Some(&[1u8; 32])).is_err());
    }

    #[test]
    fn envelopes_are_recognised_and_plaintext_is_not() {
        let key = [7u8; 32];
        assert!(is_encrypted_blob(
            &encrypt_blob(b"hello world", &key).unwrap()
        ));
        assert!(is_encrypted_blob(
            &encrypt_blob_compressed(b"hello world", &key).unwrap()
        ));

        // What a knowledge document now looks like on the wire.
        assert!(!is_encrypted_blob(
            b"# A note\n\nplain markdown, no envelope"
        ));
        assert!(!is_encrypted_blob(b""));
        assert!(!is_encrypted_blob(b"AMXC"));
        // Magic without a version byte we ever wrote is a document, not an
        // envelope — and treating it as one would strand the file forever.
        let mut impostor = b"AMXC".to_vec();
        impostor.push(9);
        impostor.extend_from_slice(&[0u8; 32]);
        assert!(!is_encrypted_blob(&impostor));
    }
    use crate::team_shared_env::derive_key;

    fn test_key() -> [u8; 32] {
        derive_key("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
            .expect("derive_key failed")
    }

    #[test]
    fn test_roundtrip() {
        let key = test_key();
        let plaintext = b"hello OSS sync world";
        let blob = encrypt_blob(plaintext, &key).expect("encrypt failed");
        assert!(blob.starts_with(b"AMXC"));
        assert_eq!(blob[4], 1);
        let decrypted = decrypt_blob(&blob, &key).expect("decrypt failed");
        assert_eq!(&decrypted, plaintext);
    }

    #[test]
    fn test_wrong_key_fails() {
        let key = test_key();
        let wrong_key =
            derive_key("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff").unwrap();
        let blob = encrypt_blob(b"secret", &key).unwrap();
        assert!(decrypt_blob(&blob, &wrong_key).is_err());
    }

    #[test]
    fn test_magic_mismatch_fails() {
        let key = test_key();
        let mut blob = encrypt_blob(b"data", &key).unwrap();
        blob[0] = b'X'; // corrupt magic
        assert!(decrypt_blob(&blob, &key).is_err());
    }

    #[test]
    fn test_unsupported_version_fails() {
        let key = test_key();
        let mut blob = encrypt_blob(b"data", &key).unwrap();
        blob[4] = 99; // unsupported version
        assert!(decrypt_blob(&blob, &key).is_err());
    }

    #[test]
    fn test_too_short_fails() {
        let key = test_key();
        let short = b"AMXC\x01";
        assert!(decrypt_blob(short, &key).is_err());
    }

    #[test]
    fn test_sha256_hex() {
        let h = sha256_hex(b"");
        assert_eq!(
            h,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn test_content_hash_matches_blob_sha256() {
        let key = test_key();
        let plaintext = b"test content";
        let blob = encrypt_blob(plaintext, &key).unwrap();
        let cipher_hash = sha256_hex(&blob);
        let plain_hash = sha256_hex(plaintext);
        assert_ne!(cipher_hash, plain_hash);
        let decrypted = decrypt_blob(&blob, &key).unwrap();
        assert_eq!(sha256_hex(&decrypted), plain_hash);
    }

    // ── v2 / compression ────────────────────────────────────────────────────

    #[test]
    fn test_v2_compressed_roundtrip_and_shrinks() {
        let key = test_key();
        // Highly compressible text (skills/knowledge are text-y).
        let plaintext = "the quick brown fox ".repeat(500);
        let pt = plaintext.as_bytes();
        let v2 = encrypt_blob_compressed(pt, &key).expect("encrypt_compressed failed");
        assert_eq!(&v2[..4], b"AMXC");
        assert_eq!(v2[4], 2, "should be v2");
        assert_eq!(v2[5] & FLAG_DEFLATE, FLAG_DEFLATE, "should be deflated");
        // v2 compressed blob must be meaningfully smaller than the v1 blob.
        let v1 = encrypt_blob(pt, &key).unwrap();
        assert!(
            v2.len() < v1.len() / 2,
            "compressed {} should be < half of v1 {}",
            v2.len(),
            v1.len()
        );
        assert_eq!(decrypt_blob(&v2, &key).unwrap(), pt);
    }

    #[test]
    fn test_v2_incompressible_stored_raw() {
        let key = test_key();
        // Random bytes don't deflate → must be stored raw (flag unset), no negative gain.
        let mut buf = vec![0u8; 4096];
        getrandom::getrandom(&mut buf).unwrap();
        let v2 = encrypt_blob_compressed(&buf, &key).unwrap();
        assert_eq!(v2[4], 2);
        assert_eq!(v2[5] & FLAG_DEFLATE, 0, "incompressible must be stored raw");
        assert_eq!(decrypt_blob(&v2, &key).unwrap(), buf);
    }

    #[test]
    fn test_v2_empty_roundtrip() {
        let key = test_key();
        let v2 = encrypt_blob_compressed(b"", &key).unwrap();
        assert_eq!(decrypt_blob(&v2, &key).unwrap(), b"");
    }

    #[test]
    fn test_decrypt_handles_both_v1_and_v2() {
        let key = test_key();
        let pt = b"mixed-fleet content that both formats must round-trip";
        let v1 = encrypt_blob(pt, &key).unwrap();
        let v2 = encrypt_blob_compressed(pt, &key).unwrap();
        assert_eq!(decrypt_blob(&v1, &key).unwrap(), pt);
        assert_eq!(decrypt_blob(&v2, &key).unwrap(), pt);
    }

    #[test]
    fn test_v2_wrong_key_fails() {
        let key = test_key();
        let wrong =
            derive_key("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff").unwrap();
        let v2 = encrypt_blob_compressed(b"secret payload here", &key).unwrap();
        assert!(decrypt_blob(&v2, &wrong).is_err());
    }
}
