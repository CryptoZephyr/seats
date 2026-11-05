import base64
import importlib.util
import json
from pathlib import Path

import requests


RUNNER = Path("/home/ubuntu/near-research/seats-spikes/seat-nft/run_spike.py")
spec = importlib.util.spec_from_file_location("seat_spike", RUNNER)
spike = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spike)

spike.FUNDER = "seatfunder-1793834028.testnet"
spike.DAO = "seatdao-1793834090.sputnikv2.testnet"
spike.SEAT = "seats-1793834090.seatfunder-1793834028.testnet"
spike.SELLER = "seller-1793829831.testnet"
spike.BUYER = "buyer-1793829831.testnet"
raw = spike.raw
voter = "s1." + spike.SEAT


def balance(account):
    return spike.RPC.view_account(account)["result"]["amount"]


def gas_and_burn(tx):
    status = tx["raw_status"]
    outcomes = [status["transaction_outcome"]["outcome"]]
    outcomes.extend(item["outcome"] for item in status["receipts_outcome"])
    return {
        "gas_burnt": sum(int(item["gas_burnt"]) for item in outcomes),
        "tokens_burnt_yocto": str(sum(int(item["tokens_burnt"]) for item in outcomes)),
    }


upgrade_tx = "741Umfoe3Qpc2T2Bt17RhgsWjCgXDz2mBoPtp9VHyvqA"
buy_tx = next(
    item for item in raw["transactions"]
    if item.get("hash") == "3sPYsbHFbaMKfLhtaFJpQUC7UUTvXwH9Jwh6zvUhPsKy"
)
buy_cost = gas_and_burn(buy_tx)
raw["contract_upgrade"] = {
    "tx": upgrade_tx,
    "wasm_size_bytes": 319979,
    "wasm_sha256": "b003f7f66c8b0ec0d8af49e5616df14725690284e71605c7b8367929c4fae1a3",
    "code_hash": "Cr6GMKDiSQdge1eiDnk8mrmaQbQyJUy8WgGtQdpZyrr6",
    "gas_burnt": 2500000000000,
    "tokens_burnt_near": "0.0002472841857021",
    "first_signing_attempt": {
        "included": False,
        "error": "Access key for the supplied public key does not exist on the target account",
    },
}
raw["A5_retry"] = {
    "approval_proposal_id": 9,
    "approval_add_tx": "6z2sSjih3mnQQzws31dRYZDfchMevm9BLTFHbdnZoN2p",
    "approval_vote_tx": "Bz9qGHfvgRMdFyULKfAf75C3eBK6b2HjDh6mrZkxUeKH",
    "buy_tx": buy_tx["hash"],
    "buy_succeeded": not buy_tx["failed"],
    "buy_gas_burnt": buy_cost["gas_burnt"],
    "buy_tokens_burnt_yocto": buy_cost["tokens_burnt_yocto"],
    "balances_before_buy_yocto": {
        spike.SELLER: "9992123325106937400000000",
        spike.BUYER: "9892188694265449300000000",
        spike.DAO: "5950160000000000000000000",
    },
    "balances_after_buy_yocto": {
        account: balance(account)
        for account in (spike.SELLER, spike.BUYER, spike.DAO)
    },
    "owner": spike.view(spike.SEAT, "nft_token", {"token_id": "1"}),
    "seat": spike.view(spike.SEAT, "get_seat", {"token_id": "1"}),
    "voter_controller": spike.view(voter, "get_controller"),
}
raw["A5_retry"]["seller_gain_yocto"] = str(
    int(raw["A5_retry"]["balances_after_buy_yocto"][spike.SELLER])
    - int(raw["A5_retry"]["balances_before_buy_yocto"][spike.SELLER])
)
raw["A5_retry"]["dao_gain_yocto"] = str(
    int(raw["A5_retry"]["balances_after_buy_yocto"][spike.DAO])
    - int(raw["A5_retry"]["balances_before_buy_yocto"][spike.DAO])
)
raw["A5_retry"]["buyer_net_debit_yocto"] = str(
    int(raw["A5_retry"]["balances_before_buy_yocto"][spike.BUYER])
    - int(raw["A5_retry"]["balances_after_buy_yocto"][spike.BUYER])
)

proposal_kind = spike.function_call(
    spike.SEAT,
    "nft_token",
    {"token_id": "1"},
    gas=50 * spike.TGAS,
)
proposal_tx = next(
    (
        item for item in raw["transactions"]
        if item.get("label") == "A5_retry_buyer_vote_lowgas.add_proposal"
    ),
    None,
)
if proposal_tx is None:
    proposal_tx = spike.record(
        "A5_retry_buyer_vote_lowgas.add_proposal",
        spike.call_contract_capturing_failure(
            spike.DAO,
            "add_proposal",
            {
                "proposal": {
                    "description": "seat-spike: buyer voter weight",
                    "kind": proposal_kind,
                }
            },
            spike.FUNDER,
            gas="100 Tgas",
        ),
    )
    spike.require_success("A5_retry_buyer_vote_lowgas.add_proposal", proposal_tx)
proposal_id = int(spike.view(spike.DAO, "get_last_proposal_id")) - 1
pending_proposal = spike.view(spike.DAO, "get_proposal", {"id": proposal_id})
if pending_proposal.get("status") != "InProgress":
    raise RuntimeError(
        f"Buyer vote proposal {proposal_id} is not InProgress: "
        f"{pending_proposal.get('status')}"
    )
raw["A5_retry"]["buyer_vote_proposal_id"] = proposal_id
raw["A5_retry"]["buyer_vote_proposal_before"] = pending_proposal
raw["A5_retry"]["prior_wrong_id_attempt"] = {
    "tx": "C22RrvVw7P1wvCesMvyhZRvJZgqBnARQ8bpyRZNS8UME",
    "submitted_proposal_id": 9,
    "actual_open_proposal_id": proposal_id,
    "error": "ERR_PROPOSAL_NOT_READY_FOR_VOTE",
}
raw["A5_retry"]["prior_high_gas_proposal_attempt"] = {
    "tx": "4n46HGYpZrS4qfuRRtryXZ2ft5hQ8HzpZQN58c8D5dE8",
    "proposal_id": 10,
    "error": "Exceeded the prepaid gas.",
    "proposal_function_call_gas": "200000000000000",
    "corrected_function_call_gas": "50000000000000",
}

buyer_vote = spike.record(
    "A5_retry_buyer_member_vote_lowgas",
    spike.call_contract_capturing_failure(
        voter,
        "member_vote",
        {
            "proposal_id": proposal_id,
            "vote": "Approve",
            "proposal_kind": proposal_kind,
        },
        spike.BUYER,
        gas="250 Tgas",
    ),
)
spike.require_success("A5_retry_buyer_member_vote", buyer_vote)
raw["A5_retry"]["buyer_vote_tx"] = buyer_vote["hash"]
raw["A5_retry"]["buyer_vote_gas_burnt"] = gas_and_burn(buyer_vote)["gas_burnt"]
raw["A5_retry"]["buyer_vote_proposal_after"] = spike.view(
    spike.DAO, "get_proposal", {"id": proposal_id}
)

seller_vote = spike.record(
    "A5_retry_seller_member_vote",
    spike.call_contract_capturing_failure(
        voter,
        "member_vote",
        {
            "proposal_id": proposal_id,
            "vote": "Approve",
            "proposal_kind": proposal_kind,
        },
        spike.SELLER,
        gas="40 Tgas",
    ),
)
seller_vote["expected_error"] = "ERR_NOT_CONTROLLER"
seller_vote["expected_error_observed"] = (
    "ERR_NOT_CONTROLLER" in json.dumps(seller_vote.get("raw_status", {}))
)
raw["A5_retry"]["seller_vote"] = {
    "tx": seller_vote["hash"],
    "failed": seller_vote["failed"],
    "expected_error_observed": seller_vote["expected_error_observed"],
}
spike.save()

a6_buy = next(
    item for item in raw["transactions"]
    if item.get("label") == "A6_wrong_admin_buy_refunded"
)
a6_status = a6_buy["raw_status"]
a6_refund = None
receipt_statuses = {
    item["id"]: item["outcome"]["status"]
    for item in a6_status["receipts_outcome"]
}
for receipt in a6_status["receipts"]:
    if receipt.get("predecessor_id") != spike.SEAT:
        continue
    if receipt.get("receiver_id") != spike.BUYER:
        continue
    for action in receipt.get("receipt", {}).get("Action", {}).get("actions", []):
        if "Transfer" in action:
            a6_refund = {
                "receipt_id": receipt["receipt_id"],
                "amount_yocto": action["Transfer"]["deposit"],
                "status": receipt_statuses.get(receipt["receipt_id"]),
            }
raw["A6_refund_verification"] = {
    "refund_receipt": a6_refund,
    "buyer_balance_before_yocto": a6_buy["signer_balance_before_yocto"],
    "buyer_balance_after_yocto": a6_buy["signer_balance_after_yocto"],
    "buyer_net_debit_yocto": str(
        int(a6_buy["signer_balance_before_yocto"])
        - int(a6_buy["signer_balance_after_yocto"])
    ),
    "gas_tokens_burnt_yocto": a6_buy["tokens_burnt_yocto"],
    "expected_error_observed": a6_buy["expected_error_observed"],
}

expired_kind = spike.function_call(
    spike.SEAT,
    "approve_sale",
    {
        "token_id": "1",
        "buyer": spike.SELLER,
        "price": "100000000000000000000000",
        "expires_in_ns": 1,
    },
)
next_id_before = int(spike.view(spike.DAO, "get_last_proposal_id"))
expired_add = spike.record(
    "A7_retry_expired_approval.add_proposal",
    spike.call_contract_capturing_failure(
        spike.DAO,
        "add_proposal",
        {
            "proposal": {
                "description": "A7 retry expired approval",
                "kind": expired_kind,
            }
        },
        spike.FUNDER,
        gas="100 Tgas",
    ),
)
spike.require_success("A7_retry_expired_approval.add_proposal", expired_add)
next_id_after = int(spike.view(spike.DAO, "get_last_proposal_id"))
expired_approval_id = next_id_after - 1
if expired_approval_id != next_id_before:
    raise RuntimeError(
        f"Unexpected DAO proposal ID sequence: before={next_id_before}, "
        f"after={next_id_after}"
    )
expired_vote = spike.record(
    "A7_retry_expired_approval.vote_approve",
    spike.call_contract_capturing_failure(
        spike.DAO,
        "act_proposal",
        {
            "id": expired_approval_id,
            "action": "VoteApprove",
            "proposal": expired_kind,
            "memo": None,
        },
        spike.FUNDER,
        gas="300 Tgas",
    ),
)
spike.require_success("A7_retry_expired_approval.vote_approve", expired_vote)
spike.view(spike.DAO, "get_proposal", {"id": expired_approval_id})
approval = spike.view(spike.SEAT, "get_seat", {"token_id": "1"})["approval"]
block = requests.post(
    "https://rpc.testnet.near.org",
    json={"jsonrpc": "2.0", "id": 1, "method": "block", "params": {"finality": "final"}},
    timeout=30,
).json()["result"]
block_timestamp = int(block["header"]["timestamp_nanosec"])
if block_timestamp < int(approval["expires_at"]):
    raise RuntimeError("A7 approval has not expired at the current final block")
expired_buy = spike.attempt(
    "A7_retry_expired_buy",
    spike.SELLER,
    "buy",
    {"token_id": "1"},
    "0.1 NEAR",
    "40 Tgas",
    expected_error="ERR_APPROVAL_EXPIRED",
)
if not expired_buy.get("expected_error_observed"):
    raise RuntimeError("A7 did not return ERR_APPROVAL_EXPIRED")
raw["A7_retry"] = {
    "approval_proposal_id": expired_approval_id,
    "approval_add_tx": expired_add["hash"],
    "approval_vote_tx": expired_vote["hash"],
    "approval": approval,
    "final_block_timestamp_ns_before_buy": block_timestamp,
    "buy_tx": expired_buy["hash"],
    "expected_error_observed": expired_buy["expected_error_observed"],
    "owner_after_buy_attempt": spike.view(
        spike.SEAT, "nft_token", {"token_id": "1"}
    ),
}

raw["final"] = raw.get("final", {})
raw["final"]["seat_storage_usage"] = spike.view(spike.SEAT, "get_storage_usage")
raw["final"]["balances"] = {
    account: balance(account)
    for account in (
        spike.FUNDER,
        spike.DAO,
        spike.SEAT,
        spike.SELLER,
        spike.BUYER,
    )
}
raw["final"]["seat_account"] = spike.RPC.view_account(spike.SEAT)["result"]
spike.save()
print(
    json.dumps(
        {
            "buyer_vote_proposal_id": proposal_id,
            "buyer_vote_tx": buyer_vote["hash"],
            "buyer_vote_succeeded": not buyer_vote["failed"],
            "seller_rejected": seller_vote["expected_error_observed"],
            "a6_refund": a6_refund,
            "expired_buy_tx": expired_buy["hash"],
            "expired_error": expired_buy["expected_error_observed"],
            "seat_storage_usage": raw["final"]["seat_storage_usage"],
        },
        sort_keys=True,
    )
)
