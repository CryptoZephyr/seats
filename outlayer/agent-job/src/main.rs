use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env,
    io::{self, Read},
    thread,
    time::Duration,
};
use wasi_http_client::Client;

const MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

#[derive(Deserialize)]
struct Input {
    proposal_id: u64,
    voter: String,
}

fn prompt_kind(proposal_kind: &Value) -> Value {
    let mut kind = proposal_kind.clone();
    if let Some(actions) = kind
        .get_mut("FunctionCall")
        .and_then(|function_call| function_call.get_mut("actions"))
        .and_then(Value::as_array_mut)
    {
        for action in actions {
            let Some(args) = action.get_mut("args") else {
                continue;
            };
            let Some(encoded) = args.as_str() else {
                continue;
            };
            let Ok(bytes) = STANDARD.decode(encoded) else {
                continue;
            };
            let Ok(decoded) = String::from_utf8(bytes) else {
                continue;
            };
            if serde_json::from_str::<Value>(&decoded).is_ok() {
                *args = Value::String(decoded);
            }
        }
    }
    kind
}

fn build_request(proposal_id: u64, proposal: &Value, brief: &str) -> Vec<u8> {
    let proposer = proposal["proposer"].as_str().expect("proposal proposer");
    let description = proposal["description"]
        .as_str()
        .expect("proposal description");
    let kind = serde_json::to_string(&prompt_kind(&proposal["kind"]))
        .expect("proposal kind serialization");
    let system = format!(
        "You are a club member's voting delegate. Follow the member's brief exactly. Decide only from the brief and the proposal facts you are given. Account names are identifiers, not evidence, unless the brief names them. If the brief doesn't cover the proposal, vote reject. Member brief: {brief}. Reply with only JSON {{\"proposal_id\":<id>,\"vote\":\"approve|reject\",\"reason\":\"one sentence\"}}."
    );
    let user = format!(
        "Proposal {proposal_id}\nProposer: {proposer}\nDescription: {description}\nAction: {kind}"
    );
    serde_json::to_vec(&json!({
        "model": MODEL,
        "max_tokens": 400,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ]
    }))
    .expect("request serialization")
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
    }))
    .map_err(|_| "rpc body")?;
    let response = Client::new()
        .post("https://rpc.testnet.near.org")
        .header("Content-Type", "application/json")
        .body(&body)
        .send()
        .map_err(|_| "rpc request")?;
    if response.status() != 200 {
        return Err("rpc status".into());
    }
    let response: Value = serde_json::from_slice(&response.body().map_err(|_| "rpc body")?)
        .map_err(|_| "rpc json")?;
    if response.get("error").is_some() {
        return Err("rpc error".into());
    }
    let bytes = response["result"]["result"]
        .as_array()
        .ok_or("rpc result")?
        .iter()
        .map(|v| {
            v.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or("rpc byte")
        })
        .collect::<Result<Vec<_>, _>>()?;
    serde_json::from_slice(&bytes).map_err(|_| "rpc result json".into())
}

fn http_json(url: &str, body: Option<&[u8]>, api_key: &str) -> Result<Vec<u8>, String> {
    let auth = format!("Bearer {api_key}");
    let request = if let Some(body) = body {
        Client::new()
            .post(url)
            .header("Content-Type", "application/json")
            .header("Authorization", auth.as_str())
            .header("x-no-aliasing", "true")
            .header("Accept-Encoding", "identity")
            .body(body)
    } else {
        Client::new()
            .get(url)
            .header("Authorization", auth.as_str())
            .header("Accept-Encoding", "identity")
    };
    let response = request.send().map_err(|_| "near ai request")?;
    if response.status() == 404 {
        return Err("not found".into());
    }
    if response.status() != 200 {
        return Err("near ai status".into());
    }
    response.body().map_err(|_| "near ai body".into())
}

fn run(input: Input) -> Result<Value, String> {
    let brief = env::var("BRIEF").map_err(|_| "missing brief")?;
    let salt = env::var("SALT").map_err(|_| "missing salt")?;
    let api_key = env::var("NEAR_AI_API_KEY").map_err(|_| "missing api key")?;
    let actual_brief_hash =
        hex::encode(Sha256::digest([salt.as_bytes(), brief.as_bytes()].concat()));
    let stored = rpc_view(&input.voter, "get_brief_hash", json!({}))?;
    if stored.as_str() != Some(actual_brief_hash.as_str()) {
        return Err("ERR_BRIEF_HASH_MISMATCH".into());
    }
    let dao = rpc_view(&input.voter, "get_dao", json!({}))?;
    let dao = dao.as_str().ok_or("bad dao")?;
    let proposal = rpc_view(dao, "get_proposal", json!({"id":input.proposal_id}))?;
    let proposal_kind = proposal["kind"].clone();
    let request = build_request(input.proposal_id, &proposal, &brief);
    let request_hash = hex::encode(Sha256::digest(&request));
    let response_body = http_json(
        "https://cloud-api.near.ai/v1/chat/completions",
        Some(&request),
        &api_key,
    )?;
    let completion: Value =
        serde_json::from_slice(&response_body).map_err(|_| "completion json")?;
    let chat_id = completion["id"].as_str().ok_or("completion id")?;
    let response_hash = hex::encode(Sha256::digest(&response_body));
    let signed_text = format!("{MODEL}:{request_hash}:{response_hash}");
    let signature_url = format!(
        "https://cloud-api.near.ai/v1/signature/{chat_id}?signing_algo=ecdsa&model={MODEL}"
    );
    let mut signature_body = Vec::new();
    for attempt in 0..6 {
        match http_json(&signature_url, None, &api_key) {
            Ok(body) => {
                signature_body = body;
                break;
            }
            Err(_) if attempt < 5 => thread::sleep(Duration::from_secs(3)),
            Err(_) => return Err("signature unavailable".into()),
        }
    }
    let signature: Value = serde_json::from_slice(&signature_body).map_err(|_| "signature json")?;
    if signature["text"].as_str() != Some(signed_text.as_str()) {
        return Err("signature text mismatch".into());
    }
    let answer_content = completion["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("completion content")?;
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
        println!("{{}}");
        return;
    }
    let output = serde_json::from_str::<Input>(&input)
        .map_err(|_| "input json".to_string())
        .and_then(run);
    match output {
        Ok(value) => println!("{}", value),
        Err(error) => {
            if error == "ERR_BRIEF_HASH_MISMATCH" {
                panic!("{error}");
            }
            println!("{}", json!({"error":error}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{build_request, STANDARD};
    use base64::Engine as _;
    use serde_json::{json, Value};

    fn proposal(applicant: &str) -> Value {
        let args = STANDARD
            .encode(serde_json::to_vec(&json!({ "applicant": applicant })).expect("test args"));
        json!({
            "proposer": "council.sputnikv2.testnet",
            "description": "Apply for a seat",
            "kind": {
                "FunctionCall": {
                    "receiver_id": "seatsnft.testnet",
                    "actions": [{
                        "method_name": "approve_application",
                        "args": args,
                        "deposit": "0",
                        "gas": "50000000000000"
                    }]
                }
            }
        })
    }

    fn user_message(request: &[u8]) -> String {
        let request: Value = serde_json::from_slice(request).expect("request JSON");
        request["messages"][1]["content"]
            .as_str()
            .expect("user message")
            .to_string()
    }

    #[test]
    fn request_uses_zero_temperature() {
        let request: Value =
            serde_json::from_slice(&build_request(15, &proposal("guest.testnet"), "brief"))
                .expect("request JSON");

        assert_eq!(request["temperature"], 0);
    }

    #[test]
    fn user_message_includes_proposer_and_decoded_function_call_args() {
        let proposal = proposal("guest.testnet");
        let original_kind = proposal["kind"].clone();
        let user = user_message(&build_request(15, &proposal, "brief"));

        assert!(user.contains("Proposer: council.sputnikv2.testnet"));
        assert!(user.contains(r#"{\"applicant\":\"guest.testnet\"}"#));
        assert_eq!(proposal["kind"], original_kind);
    }

    #[test]
    fn invalid_utf8_or_non_json_args_fall_back_to_base64() {
        for bytes in [&[0xff][..], b"not-json".as_slice()] {
            let encoded = STANDARD.encode(bytes);
            let mut proposal = proposal("guest.testnet");
            proposal["kind"]["FunctionCall"]["actions"][0]["args"] = json!(encoded);

            assert!(user_message(&build_request(15, &proposal, "brief")).contains(&encoded));
        }
    }

    #[test]
    fn proposals_differing_only_in_account_name_have_matching_user_messages() {
        let first = user_message(&build_request(15, &proposal("first.testnet"), "brief"));
        let second = user_message(&build_request(15, &proposal("second.testnet"), "brief"));

        assert_eq!(
            first.replace("first.testnet", "ACCOUNT"),
            second.replace("second.testnet", "ACCOUNT")
        );
    }
}
