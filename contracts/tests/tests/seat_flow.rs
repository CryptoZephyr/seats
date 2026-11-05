use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::{
    types::{
        AccessKey, AccessKeyPermission, AccountId, Gas, KeyType, NearToken, PublicKey, SecretKey,
    },
    Account, Contract,
};
use serde_json::{json, Value};

const DAO_WASM: &[u8] = include_bytes!("../fixtures/sputnikdao2.wasm");
const SEAT_SVG: &str = include_str!("../../../design/nft/seat-label.svg");
const DAO_SVG: &str = include_str!("../../../design/nft/dao-label.svg");
const SVG_DATA_URL_PREFIX: &str = "data:image/svg+xml;base64,";
const PRICE: u128 = 100_000_000_000_000_000_000_000;
const MINT_DEPOSIT: u128 = 50_000_000_000_000_000_000_000;
const STAKING_DEPOSIT: u128 = 160_000_000_000_000_000_000;

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/wasm32-unknown-unknown/release")
        .join(name);
    std::fs::read(&path).with_context(|| format!("build contract WASM first: {}", path.display()))
}

async fn propose_and_approve(
    owner: &Account,
    dao: &Contract,
    kind: Value,
    description: &str,
) -> Result<u64> {
    let proposal_id = submit_proposal(owner, dao, kind.clone(), description).await?;
    let approved = owner
        .call(dao.id(), "act_proposal")
        .args_json(json!({
            "id": proposal_id,
            "action": "VoteApprove",
            "proposal": kind,
            "memo": null
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(approved.is_success(), "act_proposal failed: {approved:?}");
    Ok(proposal_id)
}

async fn submit_proposal(
    owner: &Account,
    dao: &Contract,
    kind: Value,
    description: &str,
) -> Result<u64> {
    let added = owner
        .call(dao.id(), "add_proposal")
        .args_json(json!({"proposal": {"description": description, "kind": kind}}))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(added.is_success(), "add_proposal failed: {added:?}");
    Ok(added.json::<u64>()?)
}

fn function_call_kind(
    receiver_id: &AccountId,
    method_name: &str,
    args: Value,
    deposit: u128,
) -> Value {
    json!({
        "FunctionCall": {
            "receiver_id": receiver_id,
            "actions": [{
                "method_name": method_name,
                "args": STANDARD.encode(serde_json::to_vec(&args).unwrap()),
                "deposit": deposit.to_string(),
                "gas": 100_000_000_000_000_u64
            }]
        }
    })
}

async fn deploy_voter(
    account: Account,
    wasm: &[u8],
    dao_id: &AccountId,
    admin_id: &AccountId,
    controller_id: &AccountId,
    agent_public_key: PublicKey,
) -> Result<Contract> {
    let voter = account.deploy(wasm).await?.into_result()?;
    let initialized = voter
        .call("new")
        .args_json(json!({
            "dao": dao_id,
            "admin": admin_id,
            "controller": controller_id,
            "window_ns": 60_000_000_000_u64,
            "agent_public_key": agent_public_key.clone(),
        }))
        .transact()
        .await?;
    ensure!(initialized.is_success(), "voter initialization failed");
    let key_added = voter
        .as_account()
        .batch(voter.id())
        .add_key(
            agent_public_key,
            AccessKey::function_call_access(
                voter.id(),
                &["request_vote"],
                Some(NearToken::from_near(1)),
            ),
        )
        .transact()
        .await?;
    ensure!(key_added.is_success(), "agent key initialization failed");
    Ok(voter)
}

async fn view_json(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract
        .view(method)
        .args_json(args)
        .await?
        .json::<Value>()?)
}

async fn mint_through_proposal(
    owner: &Account,
    dao: &Contract,
    seat: &Contract,
    token_id: &str,
    receiver_id: &AccountId,
    voter_id: &AccountId,
) -> Result<()> {
    let kind = function_call_kind(
        seat.id(),
        "mint_test_seat",
        json!({
            "token_id": token_id,
            "receiver_id": receiver_id,
            "voter_id": voter_id
        }),
        MINT_DEPOSIT,
    );
    propose_and_approve(owner, dao, kind, "Mint seat for integration test").await?;
    let token = view_json(
        seat,
        "nft_token",
        json!({"token_id": token_id}),
    )
    .await?;
    ensure!(
        token["owner_id"] == receiver_id.as_str(),
        "DAO proposal did not mint token {token_id}: {token}"
    );
    let media = token["metadata"]["media"]
        .as_str()
        .context("NFT token media is missing")?;
    ensure!(
        media.starts_with(SVG_DATA_URL_PREFIX),
        "NFT token media is not an SVG data URL"
    );
    let media_payload = STANDARD.decode(&media[SVG_DATA_URL_PREFIX.len()..])?;
    ensure!(
        media_payload.as_slice() == SEAT_SVG.as_bytes(),
        "NFT token media does not match the compiled SEAT SVG"
    );
    let media_hash = token["metadata"]["media_hash"]
        .as_str()
        .context("NFT token media hash is missing")?;
    ensure!(
        STANDARD.decode(media_hash)?.len() == 32,
        "NFT token media hash is not a SHA-256 hash"
    );

    let contract_metadata = view_json(seat, "nft_metadata", json!({})).await?;
    let icon = contract_metadata["icon"]
        .as_str()
        .context("NFT contract icon is missing")?;
    ensure!(
        icon.starts_with(SVG_DATA_URL_PREFIX),
        "NFT contract icon is not an SVG data URL"
    );
    let icon_payload = STANDARD.decode(&icon[SVG_DATA_URL_PREFIX.len()..])?;
    ensure!(
        icon_payload.as_slice() == DAO_SVG.as_bytes(),
        "NFT contract icon does not match the compiled DAO SVG"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "Run after release WASM builds"]
async fn dao_mint_resale_refund_and_member_vote() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let dao_account = worker.dev_create_account().await?;
    let dao = dao_account
        .deploy(DAO_WASM)
        .await?
        .into_result()?;
    let owner = worker.dev_create_account().await?;
    let seller = worker.dev_create_account().await?;
    let buyer = worker.dev_create_account().await?;
    let other = worker.dev_create_account().await?;
    let seller_agent_key = SecretKey::from_seed(KeyType::ED25519, "seller-agent").public_key();
    let buyer_agent_key = SecretKey::from_seed(KeyType::ED25519, "buyer-agent").public_key();
    let other_agent_key = SecretKey::from_seed(KeyType::ED25519, "other-agent").public_key();
    let seat_account = worker.dev_create_account().await?;
    let seat_wasm = wasm("seat_nft.wasm")?;
    let voter_wasm = wasm("seat_voter.wasm")?;
    let seat = seat_account
        .deploy(&seat_wasm)
        .await?
        .into_result()?;

    let policy = json!({
        "roles": [
            {
                "name": "council",
                "kind": {"Group": [owner.id()]},
                "permissions": ["*:*"],
                "vote_policy": {}
            },
            {
                "name": "players",
                "kind": {"Member": "1"},
                "permissions": [
                    "call:AddProposal",
                    "call:VoteApprove",
                    "call:VoteReject"
                ],
                "vote_policy": {
                    "call": {
                        "weight_kind": "TokenWeight",
                        "quorum": "0",
                        "threshold": [1, 2]
                    }
                }
            }
        ],
        "default_vote_policy": {
            "weight_kind": "RoleWeight",
            "quorum": "0",
            "threshold": [1, 2]
        },
        "proposal_bond": "0",
        "proposal_period": "300000000000",
        "bounty_bond": "0",
        "bounty_forgiveness_period": "0"
    });
    let initialized = dao
        .call("new")
        .args_json(json!({
            "config": {
                "name": "Seats sandbox",
                "purpose": "Seat resale integration test",
                "metadata": ""
            },
            "policy": policy
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(initialized.is_success(), "DAO initialization failed");

    let seat_initialized = seat
        .call("new")
        .args_json(json!({
            "dao": dao.id(),
            "voter_code_hash": "11111111111111111111111111111111",
            "levy_bps": 500,
            "window_ns": 60_000_000_000_u64
        }))
        .transact()
        .await?;
    ensure!(seat_initialized.is_success(), "seat initialization failed");

    propose_and_approve(
        &owner,
        &dao,
        json!({"SetStakingContract": {"staking_id": seat.id()}}),
        "Set seat contract as staking contract",
    )
    .await?;

    let voter_account = worker.dev_create_account().await?;
    let voter = deploy_voter(
        voter_account,
        &voter_wasm,
        dao.id(),
        seat.id(),
        seller.id(),
        seller_agent_key.clone(),
    )
    .await?;
    let registered = seat
        .as_account()
        .call(dao.id(), "register_delegation")
        .args_json(json!({"account_id": voter.id()}))
        .deposit(NearToken::from_yoctonear(STAKING_DEPOSIT))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(registered.is_success(), "register_delegation failed");
    voter.view_access_key(&seller_agent_key).await?;
    let delegated = seat
        .as_account()
        .call(dao.id(), "delegate")
        .args_json(json!({"account_id": voter.id(), "amount": "1"}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(delegated.is_success(), "delegate failed");

    mint_through_proposal(&owner, &dao, &seat, "1", seller.id(), voter.id()).await?;
    let controller_before = voter.view("get_controller").await?.json::<String>()?;
    ensure!(controller_before == seller.id().as_str(), "unexpected initial controller");

    let sale_approval = function_call_kind(
        seat.id(),
        "approve_sale",
        json!({
            "token_id": "1",
            "buyer": buyer.id(),
            "price": PRICE.to_string(),
            "expires_in_ns": 300_000_000_000_u64
        }),
        0,
    );
    propose_and_approve(&owner, &dao, sale_approval, "Approve first seat resale").await?;

    let seller_before = seller.view_account().await?.balance.as_yoctonear();
    let dao_before = dao.as_account().view_account().await?.balance.as_yoctonear();
    let bought = buyer
        .call(seat.id(), "buy")
        .args_json(json!({"token_id": "1", "agent_public_key": buyer_agent_key.clone()}))
        .deposit(NearToken::from_yoctonear(PRICE))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(bought.is_success(), "approved buy failed: {bought:?}");
    let owner_after = view_json(&seat, "nft_token", json!({"token_id": "1"})).await?;
    let controller_after = voter.view("get_controller").await?.json::<String>()?;
    let seller_after = seller.view_account().await?.balance.as_yoctonear();
    let dao_after = dao.as_account().view_account().await?.balance.as_yoctonear();
    ensure!(owner_after["owner_id"] == buyer.id().as_str(), "NFT owner did not change");
    ensure!(controller_after == buyer.id().as_str(), "voter controller did not change");
    ensure!(seller_after - seller_before == PRICE * 95 / 100, "seller payout was not 95%");
    ensure!(dao_after - dao_before == PRICE * 5 / 100, "DAO levy was not 5%");
    ensure!(
        voter.view_access_key(&seller_agent_key).await.is_err(),
        "seller agent key remains on the voter"
    );
    let buyer_access_key = voter.view_access_key(&buyer_agent_key).await?;
    match buyer_access_key.permission {
        AccessKeyPermission::FunctionCall(permission) => {
            ensure!(
                permission.method_names == vec!["request_vote".to_string()],
                "buyer agent key has unexpected methods: {:?}",
                permission.method_names
            );
            ensure!(
                permission.receiver_id == voter.id().as_str(),
                "buyer agent key has unexpected receiver: {}",
                permission.receiver_id
            );
        }
        AccessKeyPermission::FullAccess => anyhow::bail!("buyer agent key is full access"),
    }

    let vote_kind = function_call_kind(
        seat.id(),
        "get_storage_usage",
        json!({}),
        0,
    );
    let vote_proposal_id =
        submit_proposal(&owner, &dao, vote_kind.clone(), "Member vote after resale").await?;
    let member_vote = buyer
        .call(voter.id(), "member_vote")
        .args_json(json!({
            "proposal_id": vote_proposal_id,
            "vote": "Approve",
            "proposal_kind": vote_kind
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(member_vote.is_success(), "member_vote failed: {member_vote:?}");
    let proposal = dao
        .view("get_proposal")
        .args_json(json!({"id": vote_proposal_id}))
        .await?
        .json::<Value>()?;
    ensure!(
        proposal["votes"].get(voter.id().as_str()).is_some(),
        "DAO did not record the vote under the voter account: {proposal}"
    );

    let bad_voter_account = worker.dev_create_account().await?;
    let bad_voter = deploy_voter(
        bad_voter_account,
        &voter_wasm,
        dao.id(),
        other.id(),
        seller.id(),
        other_agent_key,
    )
    .await?;
    mint_through_proposal(&owner, &dao, &seat, "2", seller.id(), bad_voter.id()).await?;
    let bad_sale_approval = function_call_kind(
        seat.id(),
        "approve_sale",
        json!({
            "token_id": "2",
            "buyer": buyer.id(),
            "price": PRICE.to_string(),
            "expires_in_ns": 300_000_000_000_u64
        }),
        0,
    );
    propose_and_approve(&owner, &dao, bad_sale_approval, "Approve failing seat resale").await?;
    let buyer_before = buyer.view_account().await?.balance.as_yoctonear();
    let failed_buy = buyer
        .call(seat.id(), "buy")
        .args_json(json!({"token_id": "2", "agent_public_key": buyer_agent_key.clone()}))
        .deposit(NearToken::from_yoctonear(PRICE))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let buyer_after = buyer.view_account().await?.balance.as_yoctonear();
    let bad_owner = view_json(&seat, "nft_token", json!({"token_id": "2"})).await?;
    let bad_controller = bad_voter.view("get_controller").await?.json::<String>()?;
    ensure!(
        failed_buy.receipt_failures().iter().any(|outcome| {
            format!("{outcome:?}").contains("ERR_NOT_ADMIN")
        }),
        "failed sale did not reach the controller guard: {:?}",
        failed_buy
    );
    ensure!(
        buyer_before.saturating_sub(buyer_after) < 10_000_000_000_000_000_000_000,
        "failed sale did not refund the buyer's full deposit"
    );
    ensure!(bad_owner["owner_id"] == seller.id().as_str(), "failed sale moved the NFT");
    ensure!(bad_controller == seller.id().as_str(), "failed sale changed the controller");
    Ok(())
}
