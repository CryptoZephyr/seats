import importlib.util
import json
from pathlib import Path


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


def balance(account):
    return spike.RPC.view_account(account)["result"]["amount"]


def dao_action(label, method, args, deposit=0, gas=200 * spike.TGAS):
    kind = spike.function_call(spike.SEAT, method, args, deposit=deposit, gas=gas)
    next_id_before = int(spike.view(spike.DAO, "get_last_proposal_id"))
    add_tx = spike.record(
        f"{label}.add_proposal",
        spike.call_contract_capturing_failure(
            spike.DAO,
            "add_proposal",
            {"proposal": {"description": label, "kind": kind}},
            spike.FUNDER,
            gas="100 Tgas",
        ),
    )
    spike.require_success(f"{label}.add_proposal", add_tx)
    proposal_id = int(spike.view(spike.DAO, "get_last_proposal_id")) - 1
    if proposal_id != next_id_before:
        raise RuntimeError(
            f"Unexpected proposal sequence for {label}: "
            f"expected {next_id_before}, got {proposal_id}"
        )
    vote_tx = spike.record(
        f"{label}.vote_approve",
        spike.call_contract_capturing_failure(
            spike.DAO,
            "act_proposal",
            {
                "id": proposal_id,
                "action": "VoteApprove",
                "proposal": kind,
                "memo": None,
            },
            spike.FUNDER,
            gas="300 Tgas",
        ),
    )
    spike.require_success(f"{label}.vote_approve", vote_tx)
    proposal = spike.view(spike.DAO, "get_proposal", {"id": proposal_id})
    if proposal.get("status") != "Approved":
        raise RuntimeError(f"{label} proposal did not approve: {proposal}")
    return proposal_id, kind, add_tx, vote_tx


def gas_and_burn(tx):
    status = tx["raw_status"]
    outcomes = [status["transaction_outcome"]["outcome"]]
    outcomes.extend(item["outcome"] for item in status["receipts_outcome"])
    return {
        "gas_burnt": sum(int(item["gas_burnt"]) for item in outcomes),
        "tokens_burnt_yocto": str(sum(int(item["tokens_burnt"]) for item in outcomes)),
    }


failed_buy = next(
    item for item in raw["transactions"]
    if item.get("hash") == "GULsa1iGnEuLA2Tc2S4bFTTgToCi2gBdyErjBRqQsnqo"
)
failed_status = failed_buy["raw_status"]
failed_refunds = []
for receipt in failed_status.get("receipts", []):
    if receipt.get("receiver_id") != spike.BUYER:
        continue
    for action in receipt.get("receipt", {}).get("Action", {}).get("actions", []):
        if "Transfer" in action:
            failed_refunds.append(
                {
                    "receipt_id": receipt["receipt_id"],
                    "from": receipt.get("predecessor_id"),
                    "amount_yocto": action["Transfer"]["deposit"],
                }
            )
raw["A5_failed_buy_refund_audit"] = {
    "tx": failed_buy["hash"],
    "failure": "Returning joint promise is currently prohibited.",
    "deposit_yocto": "100000000000000000000000",
    "buyer_balance_before_yocto": failed_buy["signer_balance_before_yocto"],
    "buyer_balance_after_yocto": failed_buy["signer_balance_after_yocto"],
    "buyer_net_debit_yocto": str(
        int(failed_buy["signer_balance_before_yocto"])
        - int(failed_buy["signer_balance_after_yocto"])
    ),
    "gas_tokens_burnt_yocto": failed_buy["tokens_burnt_yocto"],
    "system_gas_refunds_to_buyer": failed_refunds,
    "seat_deposit_refund_receipt_found": any(
        receipt.get("from") == spike.SEAT
        and receipt.get("amount_yocto") == "100000000000000000000000"
        for receipt in failed_refunds
    ),
}
raw["atomicity_fix_deployment"] = {
    "tx": "EX4npJgCANupnEdxsn5XkHRkJxPmo7RtdcATbaTkrtyy",
    "wasm_sha256": "d3d94b0b62411e8b8b4acb9ee37f455d9faaf271ff0e9e44440e34c1b4a48b31",
    "wasm_size_bytes": 320672,
    "code_hash": "FFyCZjHCogYieutYidQDUnNcEH5SppczGXrbxpT8DfzY",
    "gas_burnt": 2500000000000,
    "tokens_burnt_near": "0.0002477563265328",
    "features": [
        "callback returns unit and uses detached transfers only",
        "per-token buy lock prevents concurrent settlements",
        "levy multiplication overflow is rejected before controller call",
        "failed controller call clears lock and refunds buyer",
    ],
}
spike.save()

mint_proposal_id, _, mint_add, mint_vote = dao_action(
    "atomicity_fresh_seat_mint",
    "mint_seat",
    {"receiver_id": spike.SELLER},
    deposit=50_000_000_000_000_000_000_000,
    gas=200 * spike.TGAS,
)
token_id = "3"
token = spike.view(spike.SEAT, "nft_token", {"token_id": token_id})
seat = spike.view(spike.SEAT, "get_seat", {"token_id": token_id})
if token is None or seat is None:
    raise RuntimeError(f"Fresh mint did not create token {token_id}")
voter = seat["voter_id"]
controller_before = spike.view(voter, "get_controller")
if controller_before != spike.SELLER:
    raise RuntimeError(f"Unexpected fresh seat controller: {controller_before}")
raw["atomicity_fresh_mint"] = {
    "proposal_id": mint_proposal_id,
    "add_tx": mint_add["hash"],
    "vote_tx": mint_vote["hash"],
    "token_id": token_id,
    "token": token,
    "seat": seat,
    "controller_before_buy": controller_before,
}
spike.save()

sale_proposal_id, sale_kind, sale_add, sale_vote = dao_action(
    "atomicity_fresh_sale_approval",
    "approve_sale",
    {
        "token_id": token_id,
        "buyer": spike.BUYER,
        "price": "100000000000000000000000",
        "expires_in_ns": 600_000_000_000,
    },
)
balances_before = {
    account: balance(account)
    for account in (spike.SELLER, spike.BUYER, spike.DAO, spike.SEAT)
}
buy = spike.record(
    "atomicity_fresh_buy",
    spike.call_contract_capturing_failure(
        spike.SEAT,
        "buy",
        {"token_id": token_id},
        spike.BUYER,
        deposit="0.1 NEAR",
        gas="80 Tgas",
    ),
)
spike.require_success("atomicity_fresh_buy", buy)
buy_views = {
    "token": spike.view(spike.SEAT, "nft_token", {"token_id": token_id}),
    "seat": spike.view(spike.SEAT, "get_seat", {"token_id": token_id}),
    "controller_after_buy": spike.view(voter, "get_controller"),
}
balances_after = {
    account: balance(account)
    for account in (spike.SELLER, spike.BUYER, spike.DAO, spike.SEAT)
}
buy_cost = gas_and_burn(buy)
raw["atomicity_fresh_sale"] = {
    "approval_proposal_id": sale_proposal_id,
    "approval_add_tx": sale_add["hash"],
    "approval_vote_tx": sale_vote["hash"],
    "buy_tx": buy["hash"],
    "buy_gas_burnt": buy_cost["gas_burnt"],
    "buy_tokens_burnt_yocto": buy_cost["tokens_burnt_yocto"],
    "controller_before": controller_before,
    "views_after": buy_views,
    "balances_before_yocto": balances_before,
    "balances_after_yocto": balances_after,
    "seller_gain_yocto": str(
        int(balances_after[spike.SELLER]) - int(balances_before[spike.SELLER])
    ),
    "dao_gain_yocto": str(
        int(balances_after[spike.DAO]) - int(balances_before[spike.DAO])
    ),
}
if buy_views["token"]["owner_id"] != spike.BUYER:
    raise RuntimeError("Fresh token owner did not change to buyer")
if buy_views["controller_after_buy"] != spike.BUYER:
    raise RuntimeError("Fresh voter controller did not change to buyer")
if raw["atomicity_fresh_sale"]["seller_gain_yocto"] != "95000000000000000000000":
    raise RuntimeError("Fresh sale seller payout did not equal 95%")
if raw["atomicity_fresh_sale"]["dao_gain_yocto"] != "5000000000000000000000":
    raise RuntimeError("Fresh sale DAO levy did not equal 5%")
spike.save()

vote_kind = spike.function_call(
    spike.SEAT,
    "nft_token",
    {"token_id": token_id},
    gas=50 * spike.TGAS,
)
next_vote_id = int(spike.view(spike.DAO, "get_last_proposal_id"))
vote_add = spike.record(
    "atomicity_buyer_vote.add_proposal",
    spike.call_contract_capturing_failure(
        spike.DAO,
        "add_proposal",
        {
            "proposal": {
                "description": "atomicity: buyer uses fresh seat weight",
                "kind": vote_kind,
            }
        },
        spike.FUNDER,
        gas="100 Tgas",
    ),
)
spike.require_success("atomicity_buyer_vote.add_proposal", vote_add)
vote_proposal_id = int(spike.view(spike.DAO, "get_last_proposal_id")) - 1
if vote_proposal_id != next_vote_id:
    raise RuntimeError("Fresh buyer-vote proposal ID sequence changed")
proposal_before_vote = spike.view(
    spike.DAO, "get_proposal", {"id": vote_proposal_id}
)
vote_tx = spike.record(
    "atomicity_buyer_member_vote",
    spike.call_contract_capturing_failure(
        voter,
        "member_vote",
        {
            "proposal_id": vote_proposal_id,
            "vote": "Approve",
            "proposal_kind": vote_kind,
        },
        spike.BUYER,
        gas="250 Tgas",
    ),
)
spike.require_success("atomicity_buyer_member_vote", vote_tx)
raw["atomicity_fresh_sale"]["buyer_vote"] = {
    "proposal_id": vote_proposal_id,
    "proposal_before": proposal_before_vote,
    "proposal_after": spike.view(
        spike.DAO, "get_proposal", {"id": vote_proposal_id}
    ),
    "tx": vote_tx["hash"],
    "gas_burnt": gas_and_burn(vote_tx)["gas_burnt"],
}
spike.save()

a6_token_id = "bad-admin"
a6_seat = spike.view(spike.SEAT, "get_seat", {"token_id": a6_token_id})
a6_owner = spike.view(spike.SEAT, "nft_token", {"token_id": a6_token_id})
if not a6_seat or not a6_owner:
    raise RuntimeError("Existing bad-admin test seat is missing")
a6_voter = a6_seat["voter_id"]
a6_controller_before = spike.view(a6_voter, "get_controller")
a6_approval_id, _, a6_add, a6_vote = dao_action(
    "atomicity_a6_reapproval",
    "approve_sale",
    {
        "token_id": a6_token_id,
        "buyer": spike.BUYER,
        "price": "100000000000000000000000",
        "expires_in_ns": 600_000_000_000,
    },
)
a6_balances_before = {
    account: balance(account)
    for account in (spike.BUYER, spike.DAO, spike.SEAT)
}
a6_buy = spike.record(
    "atomicity_a6_buy",
    spike.call_contract_capturing_failure(
        spike.SEAT,
        "buy",
        {"token_id": a6_token_id},
        spike.BUYER,
        deposit="0.1 NEAR",
        gas="80 Tgas",
    ),
)
a6_balances_after = {
    account: balance(account)
    for account in (spike.BUYER, spike.DAO, spike.SEAT)
}
a6_status = a6_buy["raw_status"]
a6_receipt_status = {
    item["id"]: item["outcome"]["status"]
    for item in a6_status.get("receipts_outcome", [])
}
a6_refund = None
for receipt in a6_status.get("receipts", []):
    if receipt.get("predecessor_id") != spike.SEAT:
        continue
    if receipt.get("receiver_id") != spike.BUYER:
        continue
    for action in receipt.get("receipt", {}).get("Action", {}).get("actions", []):
        if "Transfer" in action:
            a6_refund = {
                "receipt_id": receipt["receipt_id"],
                "amount_yocto": action["Transfer"]["deposit"],
                "status": a6_receipt_status.get(receipt["receipt_id"]),
            }
a6_after_owner = spike.view(spike.SEAT, "nft_token", {"token_id": a6_token_id})
a6_after_controller = spike.view(a6_voter, "get_controller")
raw["atomicity_a6_retry"] = {
    "approval_proposal_id": a6_approval_id,
    "approval_add_tx": a6_add["hash"],
    "approval_vote_tx": a6_vote["hash"],
    "buy_tx": a6_buy["hash"],
    "failed_controller_receipt": [
        item["outcome"]["status"].get("Failure")
        for item in a6_status.get("receipts_outcome", [])
        if item["outcome"].get("executor_id") == a6_voter
    ],
    "refund_receipt": a6_refund,
    "balances_before_yocto": a6_balances_before,
    "balances_after_yocto": a6_balances_after,
    "buyer_net_debit_yocto": str(
        int(a6_balances_before[spike.BUYER])
        - int(a6_balances_after[spike.BUYER])
    ),
    "buyer_gas_tokens_burnt_yocto": a6_buy.get("tokens_burnt_yocto"),
    "owner_before": a6_owner,
    "owner_after": a6_after_owner,
    "controller_before": a6_controller_before,
    "controller_after": a6_after_controller,
}
spike.save()
print(
    json.dumps(
        {
            "fresh_token_id": token_id,
            "fresh_buy_tx": buy["hash"],
            "controller_before": controller_before,
            "controller_after": buy_views["controller_after_buy"],
            "owner_after": buy_views["token"]["owner_id"],
            "seller_gain_yocto": raw["atomicity_fresh_sale"]["seller_gain_yocto"],
            "dao_gain_yocto": raw["atomicity_fresh_sale"]["dao_gain_yocto"],
            "buyer_vote_tx": vote_tx["hash"],
            "a6_buy_tx": a6_buy["hash"],
            "a6_refund_receipt": a6_refund,
        },
        sort_keys=True,
    )
)
