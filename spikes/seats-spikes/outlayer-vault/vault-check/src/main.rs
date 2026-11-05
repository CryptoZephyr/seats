use base64::Engine;
use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    env,
    io::{self, Read},
};
use wasi_http_client::Client;

const SEAT_CONTRACT: &str = "seats-1793834090.seatfunder-1793834028.testnet";

#[derive(Deserialize)]
struct Input {
    requester_pubkey: String,
}

fn error(code: &str) -> Value {
    json!({"error": code})
}

fn run(input: Input) -> Value {
    let Some(sender) = env::var("NEAR_SENDER_ID").ok().filter(|s| !s.is_empty()) else {
        return error("ERR_NO_SENDER");
    };
    let Ok(vault_text) = env::var("VAULT_TEXT") else {
        return error("ERR_NO_VAULT_SECRET");
    };

    let owner_args = json!({"account_id": sender, "from_index": "0", "limit": 1});
    let owner_args = match serde_json::to_vec(&owner_args) {
        Ok(args) => args,
        Err(_) => return error("ERR_RPC_ARGS"),
    };
    let request = json!({
        "jsonrpc": "2.0",
        "id": "vault-check",
        "method": "query",
        "params": {
            "request_type": "call_function",
            "finality": "final",
            "account_id": SEAT_CONTRACT,
            "method_name": "nft_tokens_for_owner",
            "args_base64": base64::engine::general_purpose::STANDARD.encode(owner_args)
        }
    });
    let request_body = match serde_json::to_vec(&request) {
        Ok(body) => body,
        Err(_) => return error("ERR_RPC_ARGS"),
    };
    let response = match Client::new()
        .post("https://rpc.testnet.near.org")
        .header("Content-Type", "application/json")
        .body(&request_body)
        .send()
    {
        Ok(response) if response.status() == 200 => response,
        _ => return error("ERR_RPC"),
    };
    let response_body = match response.body() {
        Ok(body) => body,
        Err(_) => return error("ERR_RPC"),
    };
    let rpc: Value = match serde_json::from_slice(&response_body) {
        Ok(value) => value,
        Err(_) => return error("ERR_RPC_RESPONSE"),
    };
    let Some(bytes) = rpc
        .get("result")
        .and_then(|result| result.get("result"))
        .and_then(Value::as_array)
    else {
        return error("ERR_RPC_RESPONSE");
    };
    let result_bytes: Option<Vec<u8>> = bytes
        .iter()
        .map(|byte| byte.as_u64().and_then(|value| u8::try_from(value).ok()))
        .collect();
    let Some(result_bytes) = result_bytes else {
        return error("ERR_RPC_RESPONSE");
    };
    let tokens: Value = match serde_json::from_slice(&result_bytes) {
        Ok(value) => value,
        Err(_) => return error("ERR_RPC_RESPONSE"),
    };
    if !tokens.as_array().is_some_and(|tokens| !tokens.is_empty()) {
        return error("ERR_NO_SEAT");
    }

    let requester_key = input
        .requester_pubkey
        .strip_prefix("0x")
        .unwrap_or(&input.requester_pubkey);
    let requester_key = match hex::decode(requester_key) {
        Ok(key) if key.len() == 32 => key,
        _ => return error("ERR_BAD_PUBLIC_KEY"),
    };
    let requester_key: [u8; 32] = match requester_key.try_into() {
        Ok(key) => key,
        Err(_) => return error("ERR_BAD_PUBLIC_KEY"),
    };
    let recipient = PublicKey::from(requester_key);
    let ephemeral_secret = SecretKey::generate(&mut OsRng);
    let ephemeral_public = PublicKey::from(&ephemeral_secret);
    let cipher = SalsaBox::new(&recipient, &ephemeral_secret);
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let ciphertext = match cipher.encrypt(&nonce, vault_text.as_bytes()) {
        Ok(ciphertext) => ciphertext,
        Err(_) => return error("ERR_ENCRYPTION"),
    };

    json!({
        "ok": true,
        "ephemeral_pubkey": hex::encode(ephemeral_public.as_bytes()),
        "nonce": hex::encode(nonce),
        "ciphertext": hex::encode(ciphertext)
    })
}

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        println!("{}", error("ERR_INPUT"));
        return;
    }
    let output = match serde_json::from_str::<Input>(&input) {
        Ok(input) => run(input),
        Err(_) => error("ERR_INPUT"),
    };
    println!(
        "{}",
        serde_json::to_string(&output).unwrap_or_else(|_| "{}".to_string())
    );
}
