use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{LookupSet, UnorderedMap};
use near_sdk::{
    env, near, AccountId, Allowance, Gas, NearToken, PanicOnDefault, Promise, PromiseResult,
    PublicKey,
};

const DAO_CALL_GAS: Gas = Gas::from_tgas(150);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const STALE_ERROR_GAS: Gas = Gas::from_tgas(5);
const OUTLAYER: &str = "outlayer.testnet";
const OUTLAYER_CALL_GAS: Gas = Gas::from_tgas(250);
const OUTLAYER_CALLBACK_GAS: Gas = Gas::from_tgas(30);
const OUTLAYER_DEPOSIT: NearToken = NearToken::from_yoctonear(4_000_000_500_000_000_000_000_000);

#[near(serializers = [borsh])]
struct BriefSecrets {
    account_id: AccountId,
    profile: String,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
struct PendingVote {
    vote: String,
    reason: String,
    kind_json: String,
    receipt_hash: String,
    deadline: u64,
    controller_at_submit: AccountId,
    casting: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct VoteResult {
    proposal_id: u64,
    vote: String,
    status: String,
    source: String,
    receipt_hash: Option<String>,
    error: Option<String>,
    cast: bool,
}

#[near(serializers = [json])]
pub struct PendingView {
    vote: String,
    reason: String,
    proposal_kind: Value,
    receipt_hash: String,
    deadline: U64,
    controller_at_submit: AccountId,
    casting: bool,
}

#[near(serializers = [json])]
pub struct ResultsView {
    results: Vec<VoteResult>,
    storage_usage_bytes: u64,
}

#[near(serializers = [json])]
pub struct BriefView {
    brief_hash: String,
    secrets_account_id: Option<AccountId>,
    secrets_profile: Option<String>,
}

#[near(serializers = [json])]
pub struct VoterConfigurationView {
    model_signer_hex: String,
    model: String,
    agent_wasm_url: String,
    agent_wasm_sha256: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SeatVoter {
    dao: AccountId,
    admin: AccountId,
    controller: AccountId,
    agent_public_key: Option<PublicKey>,
    window_ns: u64,
    model_signer: [u8; 20],
    model: String,
    brief_hash: String,
    brief_secrets: Option<BriefSecrets>,
    agent_wasm_url: String,
    agent_wasm_hash: String,
    pending: UnorderedMap<u64, PendingVote>,
    pending_ids: Vec<u64>,
    results: UnorderedMap<u64, VoteResult>,
    used_receipts: LookupSet<String>,
}

#[near]
impl SeatVoter {
    #[init]
    pub fn new(
        dao: AccountId,
        admin: AccountId,
        controller: AccountId,
        window_ns: u64,
        agent_public_key: PublicKey,
    ) -> Self {
        Self {
            dao,
            admin,
            controller,
            agent_public_key: Some(agent_public_key),
            window_ns,
            model_signer: [0; 20],
            model: String::new(),
            brief_hash: String::new(),
            brief_secrets: None,
            agent_wasm_url: String::new(),
            agent_wasm_hash: String::new(),
            pending: UnorderedMap::new(b"p"),
            pending_ids: Vec::new(),
            results: UnorderedMap::new(b"r"),
            used_receipts: LookupSet::new(b"u"),
        }
    }

    pub fn set_model_signer(&mut self, address_hex: String, model: String) {
        assert_eq!(env::predecessor_account_id(), self.admin, "ERR_NOT_ADMIN");
        let address = address_hex
            .strip_prefix("0x")
            .and_then(decode_hex)
            .expect("ERR_BAD_SIGNER_ADDRESS");
        assert_eq!(address.len(), 20, "ERR_BAD_SIGNER_ADDRESS");
        self.model_signer.copy_from_slice(&address);
        self.model = model;
    }

    pub fn set_brief(
        &mut self,
        brief_hash: String,
        secrets_account_id: AccountId,
        secrets_profile: String,
    ) {
        self.assert_controller();
        assert!(is_lower_hex_32(&brief_hash), "ERR_BAD_BRIEF_HASH");
        assert!(
            !secrets_profile.is_empty() && secrets_profile.chars().count() <= 64,
            "ERR_BAD_BRIEF_PROFILE"
        );
        self.brief_hash = brief_hash;
        self.brief_secrets = Some(BriefSecrets {
            account_id: secrets_account_id,
            profile: secrets_profile,
        });
    }

    pub fn pin_agent_wasm(&mut self, url: String, sha256: String) {
        assert_eq!(env::predecessor_account_id(), self.admin, "ERR_NOT_ADMIN");
        assert!(!url.is_empty(), "ERR_BAD_AGENT_WASM_URL");
        assert!(is_lower_hex_32(&sha256), "ERR_BAD_AGENT_WASM_HASH");
        self.agent_wasm_url = url;
        self.agent_wasm_hash = sha256;
    }

    pub fn get_brief_hash(&self) -> String {
        self.brief_hash.clone()
    }

    pub fn get_brief(&self) -> BriefView {
        match &self.brief_secrets {
            Some(secrets) => BriefView {
                brief_hash: self.brief_hash.clone(),
                secrets_account_id: Some(secrets.account_id.clone()),
                secrets_profile: Some(secrets.profile.clone()),
            },
            None => BriefView {
                brief_hash: self.brief_hash.clone(),
                secrets_account_id: None,
                secrets_profile: None,
            },
        }
    }

    pub fn get_dao(&self) -> AccountId {
        self.dao.clone()
    }

    pub fn get_voter_configuration(&self) -> VoterConfigurationView {
        VoterConfigurationView {
            model_signer_hex: format!("0x{}", hex_encode(&self.model_signer)),
            model: self.model.clone(),
            agent_wasm_url: self.agent_wasm_url.clone(),
            agent_wasm_sha256: self.agent_wasm_hash.clone(),
        }
    }

    pub fn submit_pending(
        &mut self,
        proposal_id: u64,
        proposal_kind: Value,
        model: String,
        request_hash: String,
        response_body: String,
        signature: String,
    ) {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "ERR_ONLY_SELF"
        );
        assert!(self.agent_wasm_url.is_empty(), "ERR_USE_REQUEST_VOTE");
        self.store_verified_receipt(
            proposal_id,
            proposal_kind,
            model,
            request_hash,
            response_body,
            signature,
        );
    }

    pub fn request_vote(&mut self, proposal_id: u64) -> Promise {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "ERR_ONLY_SELF"
        );
        assert!(!self.brief_hash.is_empty(), "ERR_BRIEF_NOT_SET");
        let brief_secrets = self.brief_secrets.as_ref().expect("ERR_BRIEF_NOT_SET");
        assert!(!self.agent_wasm_url.is_empty(), "ERR_AGENT_WASM_NOT_PINNED");
        assert!(
            self.pending.get(&proposal_id).is_none(),
            "ERR_PENDING_EXISTS"
        );
        let current = env::current_account_id();
        let input = serde_json::json!({"proposal_id": proposal_id, "voter": current}).to_string();
        let args = serde_json::json!({
            "source": {"WasmUrl": {
                "url": self.agent_wasm_url,
                "hash": self.agent_wasm_hash,
                "build_target": "wasm32-wasip2"
            }},
            "resource_limits": {
                "max_instructions": 5_000_000,
                "max_memory_mb": 16,
                "max_execution_seconds": 30
            },
            "input_data": input,
            "secrets_ref": {
                "profile": brief_secrets.profile.clone(),
                "account_id": brief_secrets.account_id.clone()
            },
            "response_format": "Json",
            "payer_account_id": null,
            "params": null
        });
        Promise::new(OUTLAYER.parse().expect("ERR_OUTLAYER_ACCOUNT"))
            .function_call(
                "request_execution".to_string(),
                serde_json::to_vec(&args).expect("ERR_SERIALIZE_OUTLAYER_ARGS"),
                OUTLAYER_DEPOSIT,
                OUTLAYER_CALL_GAS,
            )
            .then(
                Promise::new(current).function_call(
                    "on_agent_result".to_string(),
                    serde_json::to_vec(&serde_json::json!({"proposal_id": proposal_id}))
                        .expect("ERR_SERIALIZE_CALLBACK"),
                    NearToken::from_yoctonear(0),
                    OUTLAYER_CALLBACK_GAS,
                ),
            )
    }

    #[private]
    pub fn on_agent_result(&mut self, proposal_id: u64) {
        assert_eq!(env::promise_results_count(), 1, "ERR_NOT_CALLBACK");
        let bytes = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => bytes,
            PromiseResult::Failed => env::panic_str("ERR_AGENT_EXECUTION"),
        };
        let output: Value = serde_json::from_slice(&bytes).expect("ERR_AGENT_OUTPUT");
        assert!(output.get("error").is_none(), "ERR_AGENT_OUTPUT");
        let returned_id = output["proposal_id"].as_u64().expect("ERR_AGENT_OUTPUT");
        assert_eq!(returned_id, proposal_id, "ERR_WRONG_PROPOSAL");
        assert_eq!(
            output["brief_hash"].as_str(),
            Some(self.brief_hash.as_str()),
            "ERR_BRIEF_HASH_MISMATCH"
        );
        self.store_verified_receipt(
            proposal_id,
            output["proposal_kind"].clone(),
            self.model.clone(),
            output["request_hash"]
                .as_str()
                .expect("ERR_AGENT_OUTPUT")
                .to_string(),
            output["response_body"]
                .as_str()
                .expect("ERR_AGENT_OUTPUT")
                .to_string(),
            output["signature"]
                .as_str()
                .expect("ERR_AGENT_OUTPUT")
                .to_string(),
        );
    }

    fn store_verified_receipt(
        &mut self,
        proposal_id: u64,
        proposal_kind: Value,
        model: String,
        request_hash: String,
        response_body: String,
        signature: String,
    ) {
        assert!(
            self.pending.get(&proposal_id).is_none(),
            "ERR_PENDING_EXISTS"
        );
        assert_eq!(model, self.model, "ERR_WRONG_MODEL");
        assert!(
            request_hash.len() == 64
                && request_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "ERR_BAD_REQUEST_HASH"
        );
        let response_hash = hex_encode(&env::sha256(response_body.as_bytes()));
        let text = format!("{model}:{request_hash}:{response_hash}");
        let message = format!("\x19Ethereum Signed Message:\n{}{}", text.len(), text);
        let hash = env::keccak256(message.as_bytes());
        let signature = signature
            .strip_prefix("0x")
            .and_then(decode_hex)
            .filter(|bytes| bytes.len() == 65)
            .expect("ERR_BAD_SIGNATURE");
        let recovery_id = match signature[64] {
            0 | 1 => signature[64],
            27 | 28 => signature[64] - 27,
            _ => env::panic_str("ERR_BAD_SIGNATURE"),
        };
        let public_key =
            env::ecrecover(&hash, &signature[..64], recovery_id, true).expect("ERR_BAD_SIGNATURE");
        let signer_hash = env::keccak256(public_key);
        assert_eq!(&signer_hash[12..], &self.model_signer, "ERR_WRONG_SIGNER");
        let receipt_hash = hex_encode(&env::sha256(text.as_bytes()));
        assert!(
            !self.used_receipts.contains(&receipt_hash),
            "ERR_RECEIPT_USED"
        );
        self.used_receipts.insert(receipt_hash.clone());

        let response: Value = serde_json::from_str(&response_body).expect("ERR_INVALID_RESPONSE");
        let content = response
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .expect("ERR_INVALID_RESPONSE")
            .trim();
        let content = content
            .strip_prefix("```json")
            .map(str::trim)
            .and_then(|value| value.strip_suffix("```"))
            .map(str::trim)
            .unwrap_or(content);
        let answer: Value = serde_json::from_str(content).expect("ERR_INVALID_RESPONSE");
        let answer_proposal_id = answer
            .get("proposal_id")
            .and_then(Value::as_u64)
            .expect("ERR_INVALID_RESPONSE");
        assert_eq!(answer_proposal_id, proposal_id, "ERR_WRONG_PROPOSAL");
        let vote = match answer.get("vote").and_then(Value::as_str) {
            Some("approve") => "Approve",
            Some("reject") => "Reject",
            _ => env::panic_str("ERR_BAD_VOTE"),
        }
        .to_string();
        let reason = answer
            .get("reason")
            .and_then(Value::as_str)
            .expect("ERR_INVALID_RESPONSE")
            .to_string();
        let kind_json = serde_json::to_string(&proposal_kind).expect("ERR_INVALID_KIND");
        self.pending.insert(
            proposal_id,
            PendingVote {
                vote,
                reason,
                kind_json,
                receipt_hash,
                deadline: env::block_timestamp().saturating_add(self.window_ns),
                controller_at_submit: self.controller.clone(),
                casting: false,
            },
        );
        self.pending_ids.push(proposal_id);
    }

    pub fn override_vote(&mut self, proposal_id: u64, vote: String) {
        self.assert_controller();
        let mut pending = self
            .pending
            .get(&proposal_id)
            .cloned()
            .expect("ERR_NO_PENDING");
        assert!(
            env::block_timestamp() < pending.deadline,
            "ERR_WINDOW_CLOSED"
        );
        assert!(!pending.casting, "ERR_CASTING");
        pending.vote = Self::validate_vote(vote);
        self.pending.insert(proposal_id, pending);
    }

    pub fn cancel(&mut self, proposal_id: u64) {
        self.assert_controller();
        let pending = self
            .pending
            .get(&proposal_id)
            .cloned()
            .expect("ERR_NO_PENDING");
        assert!(
            env::block_timestamp() < pending.deadline,
            "ERR_WINDOW_CLOSED"
        );
        self.pending.remove(&proposal_id).expect("ERR_NO_PENDING");
        self.pending_ids.retain(|id| *id != proposal_id);
        self.set_result(VoteResult {
            proposal_id,
            vote: String::new(),
            status: "Canceled".to_string(),
            source: "controller".to_string(),
            receipt_hash: None,
            error: None,
            cast: false,
        });
    }

    pub fn cast(&mut self, proposal_id: u64) -> Promise {
        let mut pending = self
            .pending
            .get(&proposal_id)
            .cloned()
            .expect("ERR_NO_PENDING");
        if pending.controller_at_submit != self.controller {
            self.pending.remove(&proposal_id);
            self.pending_ids.retain(|id| *id != proposal_id);
            self.set_result(VoteResult {
                proposal_id,
                vote: pending.vote,
                status: "StaleController".to_string(),
                source: "pending".to_string(),
                receipt_hash: Some(pending.receipt_hash),
                error: Some("ERR_STALE_CONTROLLER".to_string()),
                cast: false,
            });
            return Promise::new(env::current_account_id()).function_call(
                "fail_stale_controller".to_string(),
                Vec::new(),
                NearToken::from_yoctonear(0),
                STALE_ERROR_GAS,
            );
        }
        assert!(env::block_timestamp() >= pending.deadline, "ERR_TOO_EARLY");
        assert!(!pending.casting, "ERR_CASTING");
        pending.casting = true;
        let vote = pending.vote.clone();
        let kind_json = pending.kind_json.clone();
        let receipt_hash = pending.receipt_hash.clone();
        self.pending.insert(proposal_id, pending);
        self.schedule_vote(
            proposal_id,
            vote,
            kind_json,
            "pending".to_string(),
            Some(receipt_hash),
        )
    }

    pub fn member_vote(&mut self, proposal_id: u64, vote: String, proposal_kind: Value) -> Promise {
        self.assert_controller();
        let vote = Self::validate_vote(vote);
        let kind_json = serde_json::to_string(&proposal_kind).expect("ERR_INVALID_KIND");
        self.schedule_vote(proposal_id, vote, kind_json, "member".to_string(), None)
    }

    pub fn set_controller(&mut self, new_controller: AccountId, agent_public_key: PublicKey) {
        assert_eq!(env::predecessor_account_id(), self.admin, "ERR_NOT_ADMIN");
        for proposal_id in std::mem::take(&mut self.pending_ids) {
            if let Some(pending) = self.pending.remove(&proposal_id) {
                self.set_result(VoteResult {
                    proposal_id,
                    vote: pending.vote,
                    status: "ClearedControllerChange".to_string(),
                    source: "pending".to_string(),
                    receipt_hash: Some(pending.receipt_hash),
                    error: None,
                    cast: false,
                });
            }
        }
        let voter_id = env::current_account_id();
        let key_rotation = match self.agent_public_key.take() {
            Some(old_key) => Promise::new(voter_id.clone()).delete_key(old_key),
            None => Promise::new(voter_id.clone()),
        };
        key_rotation
            .add_access_key_allowance(
                agent_public_key.clone(),
                Allowance::limited(NearToken::from_near(1)).expect("ERR_AGENT_KEY_ALLOWANCE"),
                voter_id,
                "request_vote",
            )
            .detach();
        // This detached receipt can fail without rolling back the controller change.
        self.agent_public_key = Some(agent_public_key);
        self.controller = new_controller;
        self.brief_hash.clear();
        self.brief_secrets = None;
    }

    pub fn get_pending(&self, proposal_id: u64) -> Option<PendingView> {
        self.pending.get(&proposal_id).map(|pending| PendingView {
            vote: pending.vote.clone(),
            reason: pending.reason.clone(),
            proposal_kind: serde_json::from_str(&pending.kind_json)
                .expect("ERR_STORED_KIND_INVALID"),
            receipt_hash: pending.receipt_hash.clone(),
            deadline: U64(pending.deadline),
            controller_at_submit: pending.controller_at_submit.clone(),
            casting: pending.casting,
        })
    }

    pub fn get_controller(&self) -> AccountId {
        self.controller.clone()
    }

    pub fn get_results(&self) -> ResultsView {
        let mut results: Vec<_> = self
            .results
            .iter()
            .map(|(_, result)| result.clone())
            .collect();
        results.sort_by_key(|result| result.proposal_id);
        ResultsView {
            results,
            storage_usage_bytes: env::storage_usage(),
        }
    }

    #[private]
    pub fn on_cast(&mut self, proposal_id: u64) {
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                if self.pending.remove(&proposal_id).is_some() {
                    self.pending_ids.retain(|id| *id != proposal_id);
                }
                if let Some(mut result) = self.results.get(&proposal_id).cloned() {
                    result.status = "Cast".to_string();
                    result.error = None;
                    result.cast = true;
                    self.set_result(result);
                }
            }
            PromiseResult::Failed => {
                if let Some(mut pending) = self.pending.get(&proposal_id).cloned() {
                    pending.casting = false;
                    self.pending.insert(proposal_id, pending);
                }
                if let Some(mut result) = self.results.get(&proposal_id).cloned() {
                    result.status = "Failed".to_string();
                    result.error = Some("DAO act_proposal promise failed".to_string());
                    result.cast = false;
                    self.set_result(result);
                }
            }
        }
    }

    #[private]
    pub fn fail_stale_controller(&self) {
        env::panic_str("ERR_STALE_CONTROLLER");
    }

    fn schedule_vote(
        &mut self,
        proposal_id: u64,
        vote: String,
        kind_json: String,
        source: String,
        receipt_hash: Option<String>,
    ) -> Promise {
        let action = if vote == "Approve" {
            "VoteApprove"
        } else {
            "VoteReject"
        };
        let proposal_kind: Value =
            serde_json::from_str(&kind_json).expect("ERR_STORED_KIND_INVALID");
        let args = serde_json::to_vec(&serde_json::json!({
            "id": proposal_id,
            "action": action,
            "proposal": proposal_kind,
            "memo": null
        }))
        .expect("ERR_SERIALIZE_DAO_CALL");
        self.set_result(VoteResult {
            proposal_id,
            vote,
            status: "Casting".to_string(),
            source,
            receipt_hash,
            error: None,
            cast: false,
        });
        Promise::new(self.dao.clone())
            .function_call(
                "act_proposal".to_string(),
                args,
                NearToken::from_yoctonear(0),
                DAO_CALL_GAS,
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_cast".to_string(),
                    serde_json::to_vec(&serde_json::json!({"proposal_id": proposal_id}))
                        .expect("ERR_SERIALIZE_CALLBACK"),
                    NearToken::from_yoctonear(0),
                    CALLBACK_GAS,
                ),
            )
    }

    fn set_result(&mut self, result: VoteResult) {
        self.results.insert(result.proposal_id, result);
    }

    fn assert_controller(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.controller,
            "ERR_NOT_CONTROLLER"
        );
    }

    fn validate_vote(vote: String) -> String {
        assert!(vote == "Approve" || vote == "Reject", "ERR_INVALID_VOTE");
        vote
    }
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |byte| match byte {
                b'0'..=b'9' => Some(byte - b'0'),
                b'a'..=b'f' => Some(byte - b'a' + 10),
                b'A'..=b'F' => Some(byte - b'A' + 10),
                _ => None,
            };
            Some(digit(pair[0])? * 16 + digit(pair[1])?)
        })
        .collect()
}

fn hex_encode(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn is_lower_hex_32(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    const VOTER: &str = "voter.testnet";
    const ADMIN: &str = "admin.testnet";
    const CONTROLLER: &str = "controller.testnet";
    const DAO: &str = "dao.testnet";
    const RECEIPT: &str = include_str!("../tests/fixtures/nearai_receipt.json");

    struct ReceiptFixture {
        model: String,
        proposal_id: u64,
        request_hash: String,
        response_body: String,
        signature: String,
        signing_address: String,
    }

    fn account_id(value: &str) -> AccountId {
        value.parse().unwrap()
    }

    fn test_agent_key() -> PublicKey {
        "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"
            .parse()
            .unwrap()
    }

    fn next_agent_key() -> PublicKey {
        "ed25519:H3C2AVAWKq5Qm7FkyDB5cHKcYKHgbiiB2BzX8DQX8CJ"
            .parse()
            .unwrap()
    }

    fn set_context(predecessor: &str, timestamp: u64) {
        let context = VMContextBuilder::new()
            .current_account_id(account_id(VOTER))
            .predecessor_account_id(account_id(predecessor))
            .block_timestamp(timestamp)
            .build();
        testing_env!(context);
    }

    fn contract_with_pending() -> SeatVoter {
        let fixture = fixture();
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(ADMIN, 100);
        contract.set_model_signer(fixture.signing_address, fixture.model.clone());
        set_context(VOTER, 100);
        contract.submit_pending(
            fixture.proposal_id,
            json!({"FunctionCall": {"receiver_id": DAO, "actions": []}}),
            fixture.model,
            fixture.request_hash,
            fixture.response_body,
            fixture.signature,
        );
        contract
    }

    fn fixture() -> ReceiptFixture {
        let receipt: Value = serde_json::from_str(RECEIPT).unwrap();
        ReceiptFixture {
            model: receipt["model"].as_str().unwrap().to_string(),
            proposal_id: receipt["proposal_id"].as_u64().unwrap(),
            request_hash: receipt["request_hash"].as_str().unwrap().to_string(),
            response_body: receipt["response_body"].as_str().unwrap().to_string(),
            signature: receipt["signature"].as_str().unwrap().to_string(),
            signing_address: receipt["signing_address"].as_str().unwrap().to_string(),
        }
    }

    #[test]
    fn valid_receipt_stores_signed_reject_and_reason() {
        let contract = contract_with_pending();
        let pending = contract.get_pending(fixture().proposal_id).unwrap();
        assert_eq!(pending.vote, "Reject");
        assert_eq!(
            pending.reason,
            "The proposal requests 80 NEAR, exceeding the member's 50 NEAR spending cap despite supporting community events."
        );
    }

    #[test]
    fn changed_response_byte_fails_signature_verification() {
        let receipt = fixture();
        let mut body = receipt.response_body.into_bytes();
        body[0] = if body[0] == b'{' { b'[' } else { body[0] ^ 1 };
        let tampered_body = String::from_utf8(body).unwrap();
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(ADMIN, 100);
        contract.set_model_signer(receipt.signing_address, receipt.model.clone());
        set_context(VOTER, 100);

        let result = catch_unwind(AssertUnwindSafe(|| {
            contract.submit_pending(
                receipt.proposal_id,
                json!({"FunctionCall": {"receiver_id": DAO, "actions": []}}),
                receipt.model,
                receipt.request_hash,
                tampered_body,
                receipt.signature,
            );
        }));
        assert!(result.is_err());
        let error = result.unwrap_err();
        let message = error
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| error.downcast_ref::<&str>().copied())
            .unwrap_or_default();
        assert!(
            message.contains("ERR_BAD_SIGNATURE") || message.contains("ERR_WRONG_SIGNER"),
            "unexpected panic: {message}"
        );
    }

    #[test]
    #[should_panic(expected = "ERR_WRONG_MODEL")]
    fn wrong_model_fails() {
        let receipt = fixture();
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(ADMIN, 100);
        contract.set_model_signer(receipt.signing_address, receipt.model.clone());
        set_context(VOTER, 100);
        contract.submit_pending(
            receipt.proposal_id,
            json!({"FunctionCall": {"receiver_id": DAO, "actions": []}}),
            "wrong-model".to_string(),
            receipt.request_hash,
            receipt.response_body,
            receipt.signature,
        );
    }

    #[test]
    #[should_panic(expected = "ERR_WRONG_PROPOSAL")]
    fn wrong_proposal_id_fails() {
        let receipt = fixture();
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(ADMIN, 100);
        contract.set_model_signer(receipt.signing_address, receipt.model.clone());
        set_context(VOTER, 100);
        contract.submit_pending(
            receipt.proposal_id + 1,
            json!({"FunctionCall": {"receiver_id": DAO, "actions": []}}),
            receipt.model,
            receipt.request_hash,
            receipt.response_body,
            receipt.signature,
        );
    }

    #[test]
    #[should_panic(expected = "ERR_RECEIPT_USED")]
    fn receipt_cannot_be_reused_for_another_proposal() {
        let receipt = fixture();
        let mut contract = contract_with_pending();
        set_context(VOTER, 101);
        contract.submit_pending(
            receipt.proposal_id + 1,
            json!({"FunctionCall": {"receiver_id": DAO, "actions": []}}),
            receipt.model,
            receipt.request_hash,
            receipt.response_body,
            receipt.signature,
        );
    }

    #[test]
    #[should_panic(expected = "ERR_USE_REQUEST_VOTE")]
    fn submit_pending_is_disabled_when_agent_is_pinned() {
        let receipt = fixture();
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(ADMIN, 100);
        contract.pin_agent_wasm("https://example.com/agent.wasm".to_string(), "a".repeat(64));
        set_context(VOTER, 100);
        contract.submit_pending(
            receipt.proposal_id,
            json!({"FunctionCall": {"receiver_id": DAO, "actions": []}}),
            receipt.model,
            receipt.request_hash,
            receipt.response_body,
            receipt.signature,
        );
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_CALLBACK")]
    fn direct_callback_without_promise_result_fails() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        contract.on_agent_result(1);
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ADMIN")]
    fn non_admin_cannot_change_agent_pin() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(CONTROLLER, 100);
        contract.pin_agent_wasm(
            "https://example.com/other-agent.wasm".to_string(),
            "b".repeat(64),
        );
    }

    #[test]
    fn override_before_deadline_succeeds() {
        let mut contract = contract_with_pending();
        set_context(CONTROLLER, 159);

        contract.override_vote(fixture().proposal_id, "Approve".to_string());

        assert_eq!(
            contract.get_pending(fixture().proposal_id).unwrap().vote,
            "Approve"
        );
    }

    #[test]
    #[should_panic(expected = "ERR_WINDOW_CLOSED")]
    fn override_at_deadline_fails() {
        let mut contract = contract_with_pending();
        set_context(CONTROLLER, 160);
        contract.override_vote(fixture().proposal_id, "Reject".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_WINDOW_CLOSED")]
    fn override_after_deadline_fails() {
        let mut contract = contract_with_pending();
        set_context(CONTROLLER, 161);
        contract.override_vote(fixture().proposal_id, "Reject".to_string());
    }

    #[test]
    #[should_panic(expected = "ERR_WINDOW_CLOSED")]
    fn cancel_at_deadline_fails() {
        let mut contract = contract_with_pending();
        set_context(CONTROLLER, 160);
        contract.cancel(fixture().proposal_id);
    }

    #[test]
    #[should_panic(expected = "ERR_WINDOW_CLOSED")]
    fn cancel_after_deadline_fails() {
        let mut contract = contract_with_pending();
        set_context(CONTROLLER, 161);
        contract.cancel(fixture().proposal_id);
    }

    #[test]
    #[should_panic(expected = "ERR_TOO_EARLY")]
    fn cast_before_deadline_fails() {
        let mut contract = contract_with_pending();
        set_context("caller.testnet", 159);
        contract.cast(fixture().proposal_id);
    }

    #[test]
    fn controller_can_set_brief() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(CONTROLLER, 100);
        let brief_hash = "a".repeat(64);
        contract.set_brief(
            brief_hash.clone(),
            account_id("secrets.testnet"),
            "brief".to_string(),
        );
        let brief = contract.get_brief();
        assert_eq!(brief.brief_hash, brief_hash);
        assert_eq!(
            brief.secrets_account_id,
            Some(account_id("secrets.testnet"))
        );
        assert_eq!(brief.secrets_profile.as_deref(), Some("brief"));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_CONTROLLER")]
    fn non_controller_cannot_set_brief() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(ADMIN, 100);
        contract.set_brief(
            "a".repeat(64),
            account_id("secrets.testnet"),
            "brief".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_BRIEF_HASH")]
    fn set_brief_rejects_bad_hash() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(CONTROLLER, 100);
        contract.set_brief(
            "not-a-hash".to_string(),
            account_id("secrets.testnet"),
            "brief".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_BAD_BRIEF_PROFILE")]
    fn set_brief_rejects_empty_profile() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(CONTROLLER, 100);
        contract.set_brief(
            "a".repeat(64),
            account_id("secrets.testnet"),
            String::new(),
        );
    }

    #[test]
    #[should_panic(expected = "ERR_BRIEF_NOT_SET")]
    fn request_vote_requires_brief_hash() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        contract.request_vote(7);
    }

    #[test]
    #[should_panic(expected = "ERR_BRIEF_NOT_SET")]
    fn request_vote_requires_brief_secrets() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        contract.brief_hash = "a".repeat(64);
        contract.request_vote(7);
    }

    #[test]
    fn admin_controller_change_clears_pending_and_stores_new_key() {
        let mut contract = contract_with_pending();
        let proposal_id = fixture().proposal_id;
        let next_controller = account_id("buyer.testnet");
        let next_key = next_agent_key();
        set_context(CONTROLLER, 101);
        contract.set_brief(
            "a".repeat(64),
            account_id("secrets.testnet"),
            "brief".to_string(),
        );
        set_context(ADMIN, 102);

        contract.set_controller(next_controller.clone(), next_key.clone());

        assert_eq!(contract.get_controller(), next_controller);
        assert_eq!(contract.agent_public_key, Some(next_key));
        assert!(contract.brief_hash.is_empty());
        assert!(contract.brief_secrets.is_none());
        assert!(contract.get_pending(proposal_id).is_none());
        assert!(contract
            .get_results()
            .results
            .iter()
            .any(|result| result.proposal_id == proposal_id
                && result.status == "ClearedControllerChange"));
    }

    #[test]
    #[should_panic(expected = "ERR_NOT_ADMIN")]
    fn non_admin_cannot_change_controller() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(CONTROLLER, 101);
        contract.set_controller(account_id("buyer.testnet"), next_agent_key());
    }

    #[test]
    fn voter_configuration_view_reports_signer_model_and_pinned_wasm() {
        set_context(VOTER, 100);
        let mut contract = SeatVoter::new(
            account_id(DAO),
            account_id(ADMIN),
            account_id(CONTROLLER),
            60,
            test_agent_key(),
        );
        set_context(ADMIN, 101);
        let signer = format!("0x{}", "1".repeat(40));
        let wasm_hash = "a".repeat(64);
        contract.set_model_signer(signer.clone(), "model-v1".to_string());
        contract.pin_agent_wasm(
            "https://example.test/agent.wasm".to_string(),
            wasm_hash.clone(),
        );

        let configuration = contract.get_voter_configuration();

        assert_eq!(configuration.model_signer_hex, signer);
        assert_eq!(configuration.model, "model-v1");
        assert_eq!(configuration.agent_wasm_url, "https://example.test/agent.wasm");
        assert_eq!(configuration.agent_wasm_sha256, wasm_hash);
    }
}
