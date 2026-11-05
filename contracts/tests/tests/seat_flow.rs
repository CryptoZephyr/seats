use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use near_workspaces::{
    types::{AccountId, Gas, NearToken},
    Account, Contract,
};
use serde_json::{json, Value};

const DAO_WASM: &[u8] = include_bytes!("../fixtures/sputnikdao2.wasm");
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
) -> Result<Contract> {
    let voter = account.deploy(wasm).await?.into_result()?;
    let initialized = voter
        .call("new")
        .args_json(json!({
            "dao": dao_id,
            "admin": admin_id,
            "controller": controller_id,
            "window_ns": 60_000_000_000_u64
        }))
        .transact()
        .await?;
    ensure!(initialized.is_success(), "voter initialization failed");
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
    let voter = deploy_voter(voter_account, &voter_wasm, dao.id(), seat.id(), seller.id()).await?;
    let registered = seat
        .as_account()
        .call(dao.id(), "register_delegation")
        .args_json(json!({"account_id": voter.id()}))
        .deposit(NearToken::from_yoctonear(STAKING_DEPOSIT))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(registered.is_success(), "register_delegation failed");
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
        .gas(Gas::from_tgas(100))
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
    let bad_voter =
        deploy_voter(bad_voter_account, &voter_wasm, dao.id(), other.id(), seller.id()).await?;
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
        .deposit(NearToken::from_yoctonear(PRICE))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    let buyer_after = buyer.view_account().await?.balance.as_yoctonear();
    let bad_owner = view_json(&seat, "nft_token", json!({"token_id": "2"})).await?;
    let bad_controller = bad_voter.view("get_controller").await?.json::<String>()?;
    ensure!(
        failed_buy.logs().iter().any(|line| line.contains("ERR_NOT_ADMIN")),
        "failed sale did not reach the controller guard: {:?}",
        failed_buy.logs()
    );
    ensure!(
        buyer_before.saturating_sub(buyer_after) < 10_000_000_000_000_000_000_000,
        "failed sale did not refund the buyer's full deposit"
    );
    ensure!(bad_owner["owner_id"] == seller.id().as_str(), "failed sale moved the NFT");
    ensure!(bad_controller == seller.id().as_str(), "failed sale changed the controller");
    Ok(())
}
