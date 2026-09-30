use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use rand::RngCore;
use sha2::{Digest, Sha256};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid encryption key")]
    InvalidKey,
    #[error("failed to encrypt payload")]
    EncryptFailed,
    #[error("failed to decrypt payload")]
    DecryptFailed,
    #[error("invalid encrypted payload")]
    InvalidPayload,
    #[error("failed to decode decrypted payload")]
    InvalidUtf8,
}

pub fn generate_token(bytes_len: usize) -> String {
    let mut bytes = vec![0_u8; bytes_len];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    format!("{digest:x}")
}

pub fn sha256_key(secret: &str) -> [u8; 32] {
    let digest = Sha256::digest(secret.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    key
}

pub fn sha256_base64_url(value: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(value.as_bytes()))
}

pub fn encrypt_with_aes256_gcm(secret: &str, plain_text: &str) -> Result<String, CryptoError> {
    let key = sha256_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CryptoError::InvalidKey)?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let encrypted = cipher
        .encrypt(nonce, plain_text.as_bytes())
        .map_err(|_| CryptoError::EncryptFailed)?;

    if encrypted.len() < 16 {
        return Err(CryptoError::InvalidPayload);
    }

    let split = encrypted.len() - 16;
    let (ciphertext, auth_tag) = encrypted.split_at(split);

    Ok(format!(
        "{}:{}:{}",
        STANDARD.encode(nonce_bytes),
        STANDARD.encode(auth_tag),
        STANDARD.encode(ciphertext)
    ))
}

pub fn decrypt_with_aes256_gcm(secret: &str, payload: &str) -> Result<String, CryptoError> {
    let parts = payload.split(':').collect::<Vec<_>>();
    let (nonce_bytes, encrypted) = match parts.as_slice() {
        [nonce_b64, encrypted_b64] => {
            let nonce_bytes = STANDARD
                .decode(nonce_b64)
                .map_err(|_| CryptoError::InvalidPayload)?;
            let encrypted = STANDARD
                .decode(encrypted_b64)
                .map_err(|_| CryptoError::InvalidPayload)?;
            (nonce_bytes, encrypted)
        }
        [nonce_b64, auth_tag_b64, ciphertext_b64] => {
            let nonce_bytes = STANDARD
                .decode(nonce_b64)
                .map_err(|_| CryptoError::InvalidPayload)?;
            let auth_tag = STANDARD
                .decode(auth_tag_b64)
                .map_err(|_| CryptoError::InvalidPayload)?;
            let ciphertext = STANDARD
                .decode(ciphertext_b64)
                .map_err(|_| CryptoError::InvalidPayload)?;
            let mut encrypted = ciphertext;
            encrypted.extend_from_slice(&auth_tag);
            (nonce_bytes, encrypted)
        }
        _ => return Err(CryptoError::InvalidPayload),
    };

    let key = sha256_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| CryptoError::InvalidKey)?;

    let decrypted = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), encrypted.as_ref())
        .map_err(|_| CryptoError::DecryptFailed)?;

    String::from_utf8(decrypted).map_err(|_| CryptoError::InvalidUtf8)
}
