use crypto_box::{
    aead::{Aead, OsRng},
    Nonce, PublicKey, SalsaBox, SecretKey,
};
use serde_json::Value;
use std::{env, fs, os::unix::fs::PermissionsExt, path::Path};

fn main() {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("generate") => {
            let secret = SecretKey::generate(&mut OsRng);
            let secret_hex = hex::encode(secret.to_bytes());
            let path = "/home/ubuntu/near-spike/secrets/outlayer-requester-c3.hex";
            fs::write(path, secret_hex).expect("write private key");
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .expect("set private key mode");
            let public = PublicKey::from(&secret);
            println!("{}", hex::encode(public.as_bytes()));
        }
        Some("decrypt") => {
            let key_path = args.get(2).expect("private key path");
            let response_path = args.get(3).expect("response JSON path");
            let secret_bytes: [u8; 32] =
                hex::decode(fs::read_to_string(key_path).expect("read private key").trim())
                    .expect("decode private key")
                    .try_into()
                    .expect("private key length");
            let secret = SecretKey::from(secret_bytes);
            let response: Value =
                serde_json::from_slice(&fs::read(response_path).expect("read response"))
                    .expect("parse response");
            let decode_field = |name: &str| {
                let value = response[name].as_str().expect("response field");
                hex::decode(value).expect("decode response field")
            };
            let ephemeral_bytes: [u8; 32] = decode_field("ephemeral_pubkey")
                .try_into()
                .expect("ephemeral key length");
            let ephemeral = PublicKey::from(ephemeral_bytes);
            let nonce_bytes = decode_field("nonce");
            let nonce = Nonce::from_slice(&nonce_bytes);
            let ciphertext = decode_field("ciphertext");
            let cipher = SalsaBox::new(&ephemeral, &secret);
            let plaintext = cipher.decrypt(nonce, ciphertext.as_ref()).expect("decrypt");
            println!("{}", String::from_utf8(plaintext).expect("UTF-8 plaintext"));
        }
        _ => panic!("usage: vault-decrypt-tool generate | decrypt KEY RESPONSE"),
    }
    assert!(Path::new("/home/ubuntu/near-spike/secrets").exists());
}
