use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{env, io::{self, Read}, thread, time::Duration};
use wasi_http_client::Client;

const MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

#[derive(Deserialize)]
struct Input {
    proposal_id: u64,
    voter: String,
}

fn rpc_view(account: &str, method: &str, args: Value) -> Result<Value, String> {
    let args = serde_json::to_vec(&args).map_err(|_| "rpc args")?;
    let body = serde_json::to_vec(&json!({
        "jsonrpc":"2.0","id":"brief-agent","method":"query",
        "params":{
            "request_type":"call_function","finality":"final",
            "account_id":account,"method_name":method,
            "args_base64":STANDARD.encode(args)
        }
    })).map_err(|_| "rpc body")?;
    let response = Client::new()
        .post("https://rpc.testnet.near.org")
        .header("Content-Type", "application/json")
        .body(&body)
        .send()
        .map_err(|_| "rpc request")?;
    if response.status() != 200 { return Err("rpc status".into()); }
    let response: Value = serde_json::from_slice(&response.body().map_err(|_| "rpc body")?)
        .map_err(|_| "rpc json")?;
    if response.get("error").is_some() { return Err("rpc error".into()); }
    let bytes = response["result"]["result"].as_array().ok_or("rpc result")?
        .iter().map(|v| v.as_u64().and_then(|n| u8::try_from(n).ok()).ok_or("rpc byte"))
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::from_slice(&bytes).map_err(|_| "rpc result json".into())
}

fn http_json(url: &str, body: Option<&[u8]>, api_key: &str) -> Result<Vec<u8>, String> {
    let auth = format!("Bearer {api_key}");
    let request = if let Some(body) = body {
        Client::new().post(url).header("Content-Type", "application/json")
            .header("Authorization", auth.as_str())
            .header("x-no-aliasing", "true")
            .header("Accept-Encoding", "identity").body(body)
    } else {
        Client::new().get(url).header("Authorization", auth.as_str())
            .header("Accept-Encoding", "identity")
    };
    let response = request.send().map_err(|_| "near ai request")?;
    if response.status() == 404 { return Err("not found".into()); }
    if response.status() != 200 { return Err("near ai status".into()); }
    response.body().map_err(|_| "near ai body".into())
}

fn run(input: Input) -> Result<Value, String> {
    let brief = env::var("BRIEF").map_err(|_| "missing brief")?;
    let salt = env::var("SALT").map_err(|_| "missing salt")?;
    let api_key = env::var("NEAR_AI_API_KEY").map_err(|_| "missing api key")?;
    let actual_brief_hash = hex::encode(Sha256::digest([salt.as_bytes(), brief.as_bytes()].concat()));
    let stored = rpc_view(&input.voter, "get_brief_hash", json!({}))?;
    if stored.as_str() != Some(actual_brief_hash.as_str()) {
        return Err("ERR_BRIEF_HASH_MISMATCH".into());
    }
    let dao = rpc_view(&input.voter, "get_dao", json!({}))?;
    let dao = dao.as_str().ok_or("bad dao")?;
    let proposal = rpc_view(dao, "get_proposal", json!({"id":input.proposal_id}))?;
    let description = proposal["description"].as_str().ok_or("proposal description")?;
    let proposal_kind = proposal["kind"].clone();
    let system = format!(
        "You are a club member's voting delegate. Member brief: {brief}. Reply with only JSON {{\"proposal_id\":<id>,\"vote\":\"approve|reject\",\"reason\":\"one sentence\"}}."
    );
    let user = format!("Proposal {}: {}", input.proposal_id, description);
    let request = serde_json::to_vec(&json!({
        "model":MODEL,"max_tokens":400,
        "messages":[{"role":"system","content":system},{"role":"user","content":user}]
    })).map_err(|_| "request serialization")?;
    let request_hash = hex::encode(Sha256::digest(&request));
    let response_body = http_json("https://cloud-api.near.ai/v1/chat/completions", Some(&request), &api_key)?;
    let completion: Value = serde_json::from_slice(&response_body).map_err(|_| "completion json")?;
    let chat_id = completion["id"].as_str().ok_or("completion id")?;
    let response_hash = hex::encode(Sha256::digest(&response_body));
    let signed_text = format!("{MODEL}:{request_hash}:{response_hash}");
    let signature_url = format!("https://cloud-api.near.ai/v1/signature/{chat_id}?signing_algo=ecdsa&model={MODEL}");
    let mut signature_body = Vec::new();
    for attempt in 0..6 {
        match http_json(&signature_url, None, &api_key) {
            Ok(body) => { signature_body = body; break; }
            Err(_) if attempt < 5 => thread::sleep(Duration::from_secs(3)),
            Err(_) => return Err("signature unavailable".into()),
        }
    }
    let signature: Value = serde_json::from_slice(&signature_body).map_err(|_| "signature json")?;
    if signature["text"].as_str() != Some(signed_text.as_str()) {
        return Err("signature text mismatch".into());
    }
    let answer_content = completion["choices"][0]["message"]["content"]
        .as_str().ok_or("completion content")?;
    let answer: Value = serde_json::from_str(answer_content.trim()).map_err(|_| "answer json")?;
    if answer["proposal_id"].as_u64() != Some(input.proposal_id) {
        return Err("answer proposal mismatch".into());
    }
    Ok(json!({
        "proposal_id": input.proposal_id,
        "brief_hash": actual_brief_hash,
        "proposal_kind": proposal_kind,
        "request_hash": request_hash,
        "response_body": String::from_utf8(response_body).map_err(|_| "response utf8")?,
        "signature": signature["signature"].as_str().ok_or("signature missing")?
    }))
}

fn main() {
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        println!("{{}}"); return;
    }
    let output = serde_json::from_str::<Input>(&input)
        .map_err(|_| "input json".to_string()).and_then(run);
    match output {
        Ok(value) => println!("{}", value),
        Err(error) => {
            if error == "ERR_BRIEF_HASH_MISMATCH" { panic!("{error}"); }
            println!("{}", json!({"error":error}));
        }
    }
}
