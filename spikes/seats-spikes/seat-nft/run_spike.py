import base64
import json
import os
import re
import requests
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "/home/ubuntu/near-spike/dao-latency")
from near_testnet import (  # noqa: E402
    DEFAULT_RPC,
    RPC,
    call_contract,
    near_cli,
    network_connection,
    run_transaction,
    successful_value,
)
import near_testnet as near_testnet_module  # noqa: E402

ROOT = Path("/home/ubuntu/near-research/seats-spikes/seat-nft")
RAW = ROOT / "raw.json"
WASM = ROOT / "target/wasm32-unknown-unknown/release/seat_nft.wasm"
FUNDER = os.environ.get("SEAT_SPIKE_FUNDER", "zspike-fund-1793103735.testnet")
SELLER = "seller-1793829831.testnet"
BUYER = "buyer-1793829831.testnet"
EXTERNAL_VOTER = "seatvoter-v2b-1793831906.testnet"
VOTER_HASH = "4ZQhU4fA6uAmWv4jMQ6vqQPpxqJszxaqSN9WB672w8mN"
TGAS = 10**12
YOCTO = 10**24
TS = int(time.time())
DAO = f"seatdao-{TS}.sputnikv2.testnet"
SEAT = f"seats-{TS}.{FUNDER}"
FACTORY = "sputnikv2.testnet"

policy = {
    "roles": [
        {
            "name": "council",
            "kind": {"Group": [FUNDER]},
            "permissions": ["*:*"],
            "vote_policy": {},
        },
        {
            "name": "players",
            "kind": {"Member": "1"},
            "permissions": [
                "call:AddProposal",
                "call:VoteApprove",
                "call:VoteReject",
            ],
            "vote_policy": {
                "call": {
                    "weight_kind": "TokenWeight",
                    "quorum": "0",
                    "threshold": [1, 2],
                }
            },
        },
    ],
    "default_vote_policy": {
        "weight_kind": "RoleWeight",
        "quorum": "0",
        "threshold": [1, 2],
    },
    "proposal_bond": "0",
    "proposal_period": "300000000000",
    "bounty_bond": "0",
    "bounty_forgiveness_period": "0",
}

raw = json.loads(RAW.read_text())


def save():
    key_pattern = re.compile(r"(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+")

    def sanitize(value):
        if isinstance(value, dict):
            return {
                key: sanitize(item)
                for key, item in value.items()
                if "public_key" not in key.lower() and "private_key" not in key.lower()
            }
        if isinstance(value, list):
            return [sanitize(item) for item in value]
        if isinstance(value, str):
            return key_pattern.sub("[KEY OMITTED]", value)
        return value

    RAW.write_text(json.dumps(sanitize(raw), indent=2) + "\n")
    RAW.chmod(0o600)


def view(account, method, args=None):
    return RPC.view_call(account, method, args or {}, finality="final")[0]


def record(label, tx):
    tx["label"] = label
    raw["transactions"].append(tx)
    save()
    return tx


def call_contract_capturing_failure(*args, **kwargs):
    original_near_cli = near_testnet_module.near_cli
    original_urlopen = near_testnet_module.urllib.request.urlopen
    original_find_transaction = near_testnet_module.find_transaction
    original_rpc_call = RPC.call
    original_tx_status = RPC.tx_status
    RPC.endpoint = DEFAULT_RPC

    def latest_account_tx(account_id):
        response = requests.post(
            "https://tx.test.fastnear.com/v0/account",
            json={"account_id": account_id, "desc": True, "limit": 3},
            timeout=20,
        )
        response.raise_for_status()
        entries = response.json().get("account_txs", [])
        return entries[0].get("transaction_hash") if entries else None

    starting_hash = latest_account_tx(args[3])

    def requests_rpc_call(method, params):
        last_error = None
        for endpoint in (DEFAULT_RPC, "https://test.rpc.fastnear.com"):
            try:
                response = requests.post(
                    endpoint,
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": method,
                        "params": params,
                    },
                    timeout=30,
                )
                if response.status_code >= 400:
                    last_error = f"HTTP {response.status_code}"
                    continue
                payload = response.json()
                if payload.get("error"):
                    last_error = json.dumps(payload["error"], sort_keys=True)
                    continue
                RPC.endpoint = endpoint
                RPC.used_endpoints.add(endpoint)
                return {
                    "endpoint": endpoint,
                    "response": payload,
                    "result": payload.get("result"),
                }
            except requests.RequestException as error:
                last_error = str(error)
        raise RuntimeError(f"RPC failed at both testnet endpoints: {last_error}")

    def find_transaction_from_history(output, signer):
        candidates = list(dict.fromkeys(near_testnet_module.BASE58.findall(output)))
        response = requests.post(
            "https://tx.test.fastnear.com/v0/account",
            json={"account_id": signer, "desc": True, "limit": 15},
            timeout=20,
        )
        response.raise_for_status()
        history = response.json().get("account_txs", [])
        hashes = [entry.get("transaction_hash") for entry in history]
        tx_hash = next((candidate for candidate in candidates if candidate in hashes), None)
        source = "cli_hash"
        if tx_hash is None:
            tx_hash = next((candidate for candidate in hashes if candidate != starting_hash), None)
            source = "latest_account_history"
        if tx_hash is None:
            raise RuntimeError(
                f"Transaction hash not found in recent account history. "
                f"CLI candidates: {candidates}"
            )
        status = requests_rpc_call(
            "EXPERIMENTAL_tx_status",
            {
                "tx_hash": tx_hash,
                "sender_account_id": signer,
                "wait_until": "FINAL",
            },
        )
        transaction_lookups.append({"hash": tx_hash, "source": source})
        return tx_hash, status

    transaction_lookups = []
    RPC.tx_status = lambda tx_hash, signer: RPC.call(
        "EXPERIMENTAL_tx_status",
        {
            "tx_hash": tx_hash,
            "sender_account_id": signer,
            "wait_until": "FINAL",
        },
    )
    RPC.call = requests_rpc_call
    near_testnet_module.find_transaction = find_transaction_from_history

    def urlopen_with_longer_timeout(request, *args, **kwargs):
        kwargs["timeout"] = max(kwargs.get("timeout", 0) or 0, 45)
        return original_urlopen(request, *args, **kwargs)

    def capture_cli(command, timeout=180):
        env = os.environ.copy()
        env["HOME"] = "/home/ubuntu/near-spike/secrets"
        env["XDG_CONFIG_HOME"] = "/home/ubuntu/near-spike/secrets/.config"
        env["NO_COLOR"] = "1"
        completed = subprocess.run(
            [near_testnet_module.NEAR, *command],
            cwd="/home/ubuntu/near-spike/dao-latency",
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        output = "\n".join(
            part for part in (completed.stdout, completed.stderr) if part
        ).strip()
        if completed.returncode and not re.search(
            r"[1-9A-HJ-NP-Za-km-z]{32,50}", output
        ):
            error = output.splitlines()[-20:]
            safe = re.sub(
                r"(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+",
                "[KEY OMITTED]",
                "\n".join(error),
            )
            raise RuntimeError(f"near-cli-rs exited {completed.returncode}: {safe}")
        return output

    near_testnet_module.near_cli = capture_cli
    near_testnet_module.urllib.request.urlopen = urlopen_with_longer_timeout
    try:
        transaction = call_contract(*args, **kwargs)
        if transaction_lookups:
            transaction["tx_lookup"] = transaction_lookups[-1]
        return transaction
    finally:
        near_testnet_module.near_cli = original_near_cli
        near_testnet_module.urllib.request.urlopen = original_urlopen
        near_testnet_module.find_transaction = original_find_transaction
        RPC.call = original_rpc_call
        RPC.tx_status = original_tx_status


def require_success(label, tx, expected_child_failure=None):
    if tx.get("failed"):
        status = tx.get("raw_status", {})
        failures = [
            outcome.get("outcome", {}).get("status", {}).get("Failure")
            for outcome in status.get("receipts_outcome", [])
            if outcome.get("outcome", {}).get("status", {}).get("Failure") is not None
        ]
        failure_text = json.dumps(failures, sort_keys=True)
        if expected_child_failure and expected_child_failure in failure_text:
            tx["expected_child_failure"] = expected_child_failure
            tx["child_receipt_failures"] = failures
            receipt_lookup = {
                receipt["receipt_id"]: receipt
                for receipt in status.get("receipts", [])
            }
            tx["refund_receipts"] = [
                {
                    "receipt_id": receipt["receipt_id"],
                    "predecessor_id": receipt.get("predecessor_id"),
                    "receiver_id": receipt.get("receiver_id"),
                    "actions": receipt.get("receipt", {}).get("Action", {}).get("actions", []),
                    "status": outcome.get("outcome", {}).get("status", {}),
                }
                for outcome in status.get("receipts_outcome", [])
                if (receipt := receipt_lookup.get(outcome.get("id")))
                and receipt.get("predecessor_id") == SEAT
                and receipt.get("receiver_id") == DAO
                and any(
                    "Transfer" in action
                    for action in receipt.get("receipt", {}).get("Action", {}).get("actions", [])
                )
            ]
            save()
            return tx
        raise RuntimeError(f"{label} failed: {json.dumps(tx.get('raw_status', {}))}")
    return tx


def submit_proposal(description, kind, expected_child_failure=None):
    tx = record(
        f"{description}.add_proposal",
        call_contract_capturing_failure(
            DAO,
            "add_proposal",
            {"proposal": {"description": description, "kind": kind}},
            FUNDER,
            gas="100 Tgas",
        ),
    )
    require_success(f"{description}.add_proposal", tx)
    proposal_id = successful_value(tx, DAO)
    if isinstance(proposal_id, str) and proposal_id.isdigit():
        proposal_id = int(proposal_id)
    if not isinstance(proposal_id, int):
        raise RuntimeError(f"Could not decode proposal id: {proposal_id!r}")
    vote = record(
        f"{description}.vote_approve",
        call_contract(
            DAO,
            "act_proposal",
            {"id": proposal_id, "action": "VoteApprove", "proposal": kind, "memo": None},
            FUNDER,
            gas="300 Tgas",
        ),
    )
    require_success(
        f"{description}.vote_approve",
        vote,
        expected_child_failure=expected_child_failure,
    )
    raw.setdefault("proposal_ids", {})[description] = proposal_id
    save()
    return proposal_id


def function_call(receiver, method, args, deposit=0, gas=200 * TGAS):
    return {
        "FunctionCall": {
            "receiver_id": receiver,
            "actions": [
                {
                    "method_name": method,
                    "args": base64.b64encode(
                        json.dumps(args, separators=(",", ":")).encode()
                    ).decode(),
                    "deposit": str(deposit),
                    "gas": str(gas),
                }
            ],
        }
    }


def dao_call(label, method, args, deposit=0, expected_child_failure=None):
    before = {
        account: RPC.view_account(account)["result"]["amount"]
        for account in (DAO, SEAT)
    }
    kind = function_call(SEAT, method, args, deposit)
    proposal_id = submit_proposal(
        label,
        kind,
        expected_child_failure=expected_child_failure,
    )
    raw.setdefault("dao_call_balances", {})[label] = {
        "before_yocto": before,
        "after_yocto": {
            account: RPC.view_account(account)["result"]["amount"]
            for account in (DAO, SEAT)
        },
    }
    save()
    return proposal_id


def attempt(
    label,
    account,
    method,
    args,
    deposit="0NEAR",
    gas="40 Tgas",
    expected_error=None,
):
    RPC.endpoint = DEFAULT_RPC
    nonce_final_before = [
        str(entry["access_key"]["nonce"])
        for entry in RPC.call(
            "query",
            {
                "request_type": "view_access_key_list",
                "finality": "final",
                "account_id": account,
            },
        )["result"]["keys"]
    ]
    before = RPC.view_account(account)["result"]["amount"]
    tx = record(
        label,
        call_contract_capturing_failure(
            SEAT,
            method,
            args,
            account,
            gas=gas,
            deposit=deposit,
        ),
    )
    tx["signer_balance_before_yocto"] = before
    tx["signer_balance_after_yocto"] = RPC.view_account(account)["result"]["amount"]
    tx["signer_nonce_final_before"] = nonce_final_before
    if expected_error:
        failure_text = json.dumps(tx.get("raw_status", {}), sort_keys=True)
        tx["expected_error"] = expected_error
        tx["expected_error_observed"] = expected_error in failure_text
    save()
    return tx


def main():
    global DAO, SEAT, FUNDER
    if not WASM.is_file():
        raise FileNotFoundError(WASM)
    resume = "--resume" in sys.argv
    continue_after_a4_approved = "--continue-after-a4-approved" in sys.argv
    continue_after_a4_no_approval = (
        "--continue-after-a4-no-approval" in sys.argv
        or continue_after_a4_approved
    )
    continue_after_a4_wrong_buyer = (
        "--continue-after-a4-wrong-buyer" in sys.argv
        or continue_after_a4_approved
    )
    continue_after_a3 = (
        "--continue-after-a3" in sys.argv
        or continue_after_a4_no_approval
        or continue_after_a4_wrong_buyer
    )
    continue_after_a2 = "--continue-after-a2" in sys.argv or continue_after_a3
    if resume or continue_after_a2:
        FUNDER = os.environ.get(
            "SEAT_SPIKE_FUNDER",
            raw.get("faucet_sponsor", {}).get("account_id", FUNDER),
        )
        DAO = raw["dao_account"]
        SEAT = raw["seat_contract"]
        raw.pop("error", None)
        raw.pop("error", None)
        raw["status"] = "resuming"
        raw["resume_starting_balances_yocto"] = {
            account: RPC.view_account(account)["result"]["amount"]
            for account in (FUNDER, DAO, SEAT, SELLER, BUYER)
        }
        a1_id = raw.get("proposal_ids", {}).get("A1_mint_seat", 1)
        existing_vote = next(
            (
                tx for tx in raw.get("transactions", [])
                if tx.get("label") == "A1_mint_seat.vote_approve"
            ),
            None,
        )
        if resume and not continue_after_a2 and not existing_vote:
            kind = function_call(
                SEAT,
                "mint_seat",
                {"receiver_id": SELLER},
                50_000_000_000_000_000_000_000,
            )
            vote = record(
                "A1_mint_seat.vote_approve",
                call_contract(
                    DAO,
                    "act_proposal",
                    {
                        "id": a1_id,
                        "action": "VoteApprove",
                        "proposal": kind,
                        "memo": None,
                    },
                    FUNDER,
                    gas="300 Tgas",
                ),
            )
            require_success("A1_mint_seat.vote_approve", vote)
        raw.setdefault("proposal_ids", {})["A1_mint_seat"] = a1_id
    else:
        raw.update(
            {
                "part": "A",
                "network": "testnet",
                "status": "running",
                "dao_account": DAO,
                "seat_contract": SEAT,
                "voter_code_hash": VOTER_HASH,
                "transactions": [],
            }
        )
        start_balances = {
            account: RPC.view_account(account)["result"]["amount"]
            for account in (FUNDER, SELLER, BUYER)
        }
        raw["starting_balances_yocto"] = start_balances

        dao_args = {
            "config": {
                "name": "Seat NFT Test",
                "purpose": "Approval-gated voting seat resale test",
                "metadata": "",
            },
            "policy": policy,
        }
        created = record(
            "factory.create_dao",
            call_contract(
                FACTORY,
                "create",
                {
                    "name": f"seatdao-{TS}",
                    "args": base64.b64encode(json.dumps(dao_args).encode()).decode(),
                },
                FUNDER,
                gas="300 Tgas",
                deposit="6 NEAR",
            ),
        )
        require_success("factory.create_dao", created)

        account_tx = record(
            "create_seat_contract_account",
            run_transaction(
                [
                    "account",
                    "create-account",
                    "fund-myself",
                    SEAT,
                    "3.5 NEAR",
                    "autogenerate-new-keypair",
                    "save-to-legacy-keychain",
                    "sign-as",
                    FUNDER,
                    "network-config",
                    network_connection(),
                    "sign-with-legacy-keychain",
                    "send",
                ],
                FUNDER,
                SEAT,
            ),
        )
        require_success("create_seat_contract_account", account_tx)
        require_success(
            "deploy_seat_contract",
            record(
                "deploy_seat_contract",
                run_transaction(
                    [
                        "contract",
                        "deploy",
                        SEAT,
                        "use-file",
                        str(WASM),
                        "without-init-call",
                        "network-config",
                        network_connection(),
                        "sign-with-legacy-keychain",
                        "send",
                    ],
                    SEAT,
                    SEAT,
                ),
            ),
        )
        require_success(
            "initialize_seat_contract",
            record(
                "initialize_seat_contract",
                call_contract(
                    SEAT,
                    "new",
                    {
                        "dao": DAO,
                        "voter_code_hash": VOTER_HASH,
                        "levy_bps": 500,
                        "window_ns": 60_000_000_000,
                    },
                    SEAT,
                    gas="100 Tgas",
                ),
            ),
        )

        staking_kind = {"SetStakingContract": {"staking_id": SEAT}}
        staking_id = submit_proposal("set_seat_staking_contract", staking_kind)
        raw["staking_proposal_id"] = staking_id

        a1_id = dao_call(
            "A1_mint_seat",
            "mint_seat",
            {"receiver_id": SELLER},
            deposit=50_000_000_000_000_000_000_000,
        )
    if not continue_after_a2:
        raw["A1"] = {
            "proposal_id": a1_id,
            "nft": view(SEAT, "nft_token", {"token_id": "1"}),
            "tokens_for_seller": view(
                SEAT,
                "nft_tokens_for_owner",
                {"account_id": SELLER, "from_index": None, "limit": 10},
            ),
            "seat": view(SEAT, "get_seat", {"token_id": "1"}),
            "delegation": view(DAO, "delegation_balance_of", {"account_id": "s1." + SEAT}),
            "total_delegation_supply": view(DAO, "delegation_total_supply"),
        }
        voter1 = raw["A1"]["seat"]["voter_id"]
        raw["A1"]["voter_account"] = RPC.view_account(voter1)["result"]
        raw["A1"]["voter_controller"] = view(voter1, "get_controller")
        raw["A1"]["voter_contract_code_hash"] = RPC.view_account(voter1)["result"]["code_hash"]
        raw["A1"]["balances_after"] = {
            account: RPC.view_account(account)["result"]["amount"]
            for account in (DAO, SEAT, SELLER)
        }

        occupied = record(
            "A2_precreate_collision_account",
            run_transaction(
                [
                    "account",
                    "create-account",
                    "fund-myself",
                    "s2." + SEAT,
                    "0.01 NEAR",
                    "autogenerate-new-keypair",
                    "save-to-legacy-keychain",
                    "sign-as",
                    SEAT,
                    "network-config",
                    network_connection(),
                    "sign-with-legacy-keychain",
                    "send",
                ],
                SEAT,
                "s2." + SEAT,
            ),
        )
        require_success("A2_precreate_collision_account", occupied)
        a2 = dao_call(
            "A2_collision_mint",
            "mint_seat",
            {"receiver_id": SELLER},
            deposit=50_000_000_000_000_000_000_000,
            expected_child_failure="AccountAlreadyExists",
        )
        raw["A2"] = {
            "proposal_id": a2,
            "nft": view(SEAT, "nft_token", {"token_id": "2"}),
            "collision_account": RPC.view_account("s2." + SEAT)["result"],
        }
    else:
        voter1 = raw["A1"]["seat"]["voter_id"]

    if not continue_after_a3:
        raw["A3"] = attempt(
            "A3_direct_transfer_rejected",
            SELLER,
            "nft_transfer",
            {"_receiver_id": BUYER, "_token_id": "1", "approval_id": None, "memo": None},
            "1 yoctoNEAR",
            expected_error="ERR_APPROVAL_REQUIRED",
        )
    if not continue_after_a4_no_approval:
        raw["A4"] = {}
        raw["A4"]["no_approval"] = attempt(
            "A4_no_approval",
            BUYER,
            "buy",
            {"token_id": "1"},
            "0.1 NEAR",
            expected_error="ERR_NO_APPROVAL",
        )
    else:
        raw.setdefault("A4", {})
    if not continue_after_a4_approved:
        raw["A4"]["approval_id"] = dao_call(
            "A4_approve_buyer",
            "approve_sale",
            {
                "token_id": "1",
                "buyer": BUYER,
                "price": "100000000000000000000000",
                "expires_in_ns": 600_000_000_000,
            },
        )
    else:
        raw["A4"]["approval_id"] = raw["proposal_ids"]["A4_approve_buyer"]
    if not continue_after_a4_wrong_buyer:
        raw["A4"]["wrong_buyer"] = attempt(
            "A4_wrong_buyer",
            SELLER,
            "buy",
            {"token_id": "1"},
            "0.1 NEAR",
            expected_error="ERR_WRONG_BUYER",
        )
    raw["A4"]["wrong_deposit"] = attempt(
        "A4_wrong_deposit",
        BUYER,
        "buy",
        {"token_id": "1"},
        "0.09 NEAR",
        expected_error="ERR_WRONG_DEPOSIT",
    )

    raw["A5"] = {}
    raw["A5"]["proposal"] = dao_call(
        "A5_approve_sale",
        "approve_sale",
        {
            "token_id": "1",
            "buyer": BUYER,
            "price": "100000000000000000000000",
            "expires_in_ns": 600_000_000_000,
        },
    )
    raw["A5"]["balances_before_buy"] = {
        account: RPC.view_account(account)["result"]["amount"]
        for account in (SELLER, BUYER, DAO)
    }
    raw["A5"]["buy"] = attempt(
        "A5_approved_buy",
        BUYER,
        "buy",
        {"token_id": "1"},
        "0.1 NEAR",
        "80 Tgas",
    )
    raw["A5"]["nft"] = view(SEAT, "nft_token", {"token_id": "1"})
    raw["A5"]["tokens_for_buyer"] = view(
        SEAT,
        "nft_tokens_for_owner",
        {"account_id": BUYER, "from_index": None, "limit": 10},
    )
    raw["A5"]["seat"] = view(SEAT, "get_seat", {"token_id": "1"})
    raw["A5"]["voter_controller"] = view(voter1, "get_controller")
    raw["A5"]["balances_after_buy"] = {
        account: RPC.view_account(account)["result"]["amount"]
        for account in (SELLER, BUYER, DAO)
    }
    vote_kind = function_call(SEAT, "nft_token", {"token_id": "1"})
    p = submit_proposal("A5_buyer_vote", vote_kind)
    raw["A5"]["member_vote"] = record(
        "A5_buyer_member_vote",
        call_contract_capturing_failure(
            voter1,
            "member_vote",
            {"proposal_id": p, "vote": "Approve", "proposal_kind": vote_kind},
            BUYER,
            gas="100 Tgas",
        ),
    )
    raw["A5"]["proposal_after_vote"] = view(DAO, "get_proposal", {"id": p})
    raw["A5"]["seller_vote_rejected"] = record(
        "A5_seller_member_vote_rejected",
        call_contract_capturing_failure(
            voter1,
            "member_vote",
            {"proposal_id": p + 1, "vote": "Approve", "proposal_kind": vote_kind},
            SELLER,
            gas="40 Tgas",
        ),
    )
    raw["A5"]["seller_vote_rejected"]["expected_error"] = "ERR_NOT_CONTROLLER"
    raw["A5"]["seller_vote_rejected"]["expected_error_observed"] = (
        "ERR_NOT_CONTROLLER"
        in json.dumps(raw["A5"]["seller_vote_rejected"].get("raw_status", {}))
    )

    raw["A6"] = {}
    raw["A6"]["mint"] = dao_call(
        "A6_test_fixture",
        "mint_test_seat",
        {
            "token_id": "bad-admin",
            "receiver_id": SELLER,
            "voter_id": EXTERNAL_VOTER,
        },
    )
    raw["A6"]["approval"] = dao_call(
        "A6_approve_sale",
        "approve_sale",
        {
            "token_id": "bad-admin",
            "buyer": BUYER,
            "price": "100000000000000000000000",
            "expires_in_ns": 600_000_000_000,
        },
    )
    raw["A6"]["buy"] = attempt(
        "A6_wrong_admin_buy_refunded",
        BUYER,
        "buy",
        {"token_id": "bad-admin"},
        "0.1 NEAR",
        "80 Tgas",
        expected_error="ERR_NOT_ADMIN",
    )
    raw["A6"]["nft_after"] = view(SEAT, "nft_token", {"token_id": "bad-admin"})

    raw["A7"] = {}
    raw["A7"]["approval"] = dao_call(
        "A7_expired_approval",
        "approve_sale",
        {
            "token_id": "1",
            "buyer": SELLER,
            "price": "100000000000000000000000",
            "expires_in_ns": 1,
        },
    )
    time.sleep(2)
    raw["A7"]["buy"] = attempt(
        "A7_expired_buy",
        SELLER,
        "buy",
        {"token_id": "1"},
        "0.1 NEAR",
        expected_error="ERR_APPROVAL_EXPIRED",
    )

    raw["final"] = {
        "balances": {
            account: RPC.view_account(account)["result"]["amount"]
            for account in (FUNDER, DAO, SEAT, SELLER, BUYER)
        },
        "seat_storage_usage": view(SEAT, "get_storage_usage"),
        "seat_metadata": view(SEAT, "nft_metadata"),
        "seat_account": RPC.view_account(SEAT)["result"],
        "dao_staking_id": view(DAO, "get_staking_contract"),
        "delegation_balance": view(DAO, "delegation_balance_of", {"account_id": voter1}),
    }
    raw["status"] = "executed"
    save()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raw["status"] = "failed"
        raw["error"] = str(error)
        save()
        raise
