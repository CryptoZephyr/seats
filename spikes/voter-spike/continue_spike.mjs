import fs from "node:fs";
import path from "node:path";
import { actionCreators } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/transactions/lib/esm/index.js";
import { KeyPair } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/crypto/lib/esm/index.js";
import { KeyPairSigner } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/signers/lib/esm/index.js";
import {
  accountState,
  callKind,
  loadCredential,
  prepareTransaction,
  rpc,
  sendPrepared,
  transactionError,
  viewContract,
  redactError,
} from "/home/ubuntu/near-spike/dao-latency/fc_key_common.mjs";

const OWNER = "zspike-1793094130.testnet";
const DAO = `dao.${OWNER}`;
const WEIGHT = `weight.${OWNER}`;
const VOTER = "seatvoter-1793829831.testnet";
const SELLER = "seller-1793829831.testnet";
const BUYER = "buyer-1793829831.testnet";
const RAW_PATH = "/home/ubuntu/near-research/voter-spike/raw.json";
const SECRET_PATH = "/home/ubuntu/near-spike/secrets/seat-voter-spike/agent-fc-key.json";
const T_GAS = 10n ** 12n;
const WINDOW_NS = 60_000_000_000n;
const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
const YOCTO = 10n ** 24n;

function saveRaw() {
  fs.writeFileSync(RAW_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(RAW_PATH, 0o600);
}

function outcomes(result) {
  const tx = result?.transaction_outcome?.outcome
    ? { id: result.transaction_outcome.id, ...result.transaction_outcome.outcome }
    : null;
  const receipts = (result?.receipts_outcome ?? []).map((item) => ({ id: item.id, ...item.outcome }));
  const all = [tx, ...receipts].filter(Boolean);
  const sum = (field) => all.reduce((value, item) => value + BigInt(item?.[field] ?? 0), 0n);
  return {
    transaction: tx,
    receipts,
    gas: String(sum("gas_burnt")),
    tokens: String(sum("tokens_burnt")),
  };
}

async function send(account, receiver, action, label, details = {}) {
  const prepared = await prepareTransaction(account, receiver, action, raw.rpc_calls);
  const entry = {
    label,
    signer_id: account.accountId,
    receiver_id: receiver,
    attempted_hash: prepared.hash,
    prepared_utc: prepared.prepared_utc,
    ...details,
  };
  let sent;
  try {
    sent = await sendPrepared(prepared, raw.rpc_calls);
  } catch (error) {
    account.nonce = null;
    entry.included = false;
    entry.error = redactError(error);
    entry.status = "RejectedBeforeInclusion";
    entry.finished_utc = new Date().toISOString();
    raw.transactions.push(entry);
    saveRaw();
    return { record: entry, result: null };
  }
  await sent.blockPromise;
  let result = sent.result;
  try {
    result = (await rpc("tx", {
      tx_hash: prepared.hash,
      sender_account_id: account.accountId,
      wait_until: "FINAL",
    }, raw.rpc_calls)).result;
  } catch (error) {
    entry.finality_read_error = redactError(error);
  }
  const detail = outcomes(result);
  entry.included = true;
  entry.final_status = result?.final_execution_status ?? null;
  entry.status = result?.status ?? null;
  entry.error = transactionError(result);
  entry.block_hash = result?.transaction_outcome?.block_hash ?? sent.record.block_hash;
  entry.block_height = result?.transaction_outcome?.outcome?.block_height ?? sent.record.block_height;
  entry.block_timestamp_nanosec = sent.record.block_timestamp_nanosec ?? null;
  entry.block_timestamp_utc = sent.record.block_timestamp_utc ?? null;
  entry.gas_burnt_total = detail.gas;
  entry.tokens_burnt_total = detail.tokens;
  entry.transaction_outcome = detail.transaction;
  entry.receipts_outcome = detail.receipts;
  entry.finished_utc = new Date().toISOString();
  raw.transactions.push(entry);
  saveRaw();
  return { record: entry, result };
}

async function call(account, receiver, method, args, tgas, label, deposit = 0n) {
  const gas = BigInt(tgas) * T_GAS;
  return send(account, receiver, actionCreators.functionCall(method, args, gas, deposit), label, {
    method,
    gas_attached: String(gas),
    deposit_yocto: String(deposit),
    args,
  });
}

async function view(account, method, args = {}) {
  return (await viewContract(account, method, args, "final", raw.rpc_calls)).value;
}

async function proposal(label, leg) {
  const id = Number(await view(DAO, "get_last_proposal_id"));
  const data = {
    description: `voter-spike: ${label}`,
    kind: callKind(leg),
  };
  const result = await call(loadCredential(OWNER), DAO, "add_proposal", { proposal: data }, 60, `${label}.add_proposal`);
  if (result.record.error) throw new Error(`${label} add_proposal failed: ${result.record.error}`);
  raw.tests[label] = {
    proposal_id: id,
    race_leg: leg,
    proposal: data,
    tx_hash: result.record.attempted_hash,
  };
  saveRaw();
  return id;
}

async function waitDeadline(deadline) {
  while (true) {
    const block = await rpc("block", { finality: "final" }, raw.rpc_calls);
    const timestamp = BigInt(block.result.header.timestamp_nanosec);
    raw.views.last_final_timestamp_nanosec = String(timestamp);
    saveRaw();
    if (timestamp >= deadline) return String(timestamp);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

const p1Tx = raw.transactions.find((item) => item.label === "P1.add_proposal");
const p1 = Number(Buffer.from(p1Tx.status.SuccessValue, "base64").toString("utf8"));
const owner = loadCredential(OWNER);
const voterFull = loadCredential(VOTER);
const seller = loadCredential(SELLER);
const buyer = loadCredential(BUYER);
const secret = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
const pair = KeyPair.fromString(secret.private_key);
const agent = {
  accountId: VOTER,
  publicKey: pair.getPublicKey(),
  signer: KeyPairSigner.fromSecretKey(secret.private_key),
  nonce: null,
};
const p1View = await view(DAO, "get_proposal", { id: p1 });
raw.tests.P1 = { proposal_id: p1, proposal: p1View };
saveRaw();

let sent = await call(seller, VOTER, "member_vote", {
  proposal_id: p1,
  vote: "Approve",
  proposal_kind: callKind(60),
}, 220, "T2.seller_member_vote_P1");
raw.tests.T2 = { tx: sent.record, proposal: await view(DAO, "get_proposal", { id: p1 }), results: await view(VOTER, "get_results") };
saveRaw();

const p2 = await proposal("P2", 61);
sent = await call(agent, VOTER, "submit_pending", {
  proposal_id: p2, vote: "Approve", proposal_kind: callKind(61), receipt_hash: "voter-spike-P2",
}, 30, "T3.agent_submit_P2");
if (sent.record.error) throw new Error(`P2 submit failed: ${sent.record.error}`);
const p2Submit = sent.record;
const p2Pending = await view(VOTER, "get_pending", { proposal_id: p2 });
sent = await call(buyer, VOTER, "cast", { proposal_id: p2 }, 220, "T3.immediate_cast_P2");
raw.tests.T3 = {
  submit: p2Submit,
  pending_after_submit: p2Pending,
  early_cast: sent.record,
  early_cast_has_dao_receipt: sent.record.receipts_outcome?.some((item) => item.executor_id === DAO) ?? false,
  early_cast_err_too_early: String(sent.record.error ?? "").includes("ERR_TOO_EARLY"),
};

const restricted = [];
for (const [method, args] of [
  ["override_vote", { proposal_id: p2, vote: "Reject" }],
  ["cancel", { proposal_id: p2 }],
  ["set_controller", { new_controller: BUYER }],
  ["member_vote", { proposal_id: p2, vote: "Approve", proposal_kind: callKind(61) }],
]) {
  restricted.push((await call(agent, VOTER, method, args, 30, `T5.agent_${method}`)).record);
}
const transfer = await send(agent, BUYER, actionCreators.transfer(1n), "T5.agent_transfer", {
  method: "Transfer",
  deposit_yocto: "1",
});
const directDao = await call(agent, DAO, "act_proposal", {
  id: p2, action: "VoteApprove", proposal: callKind(61), memo: null,
}, 30, "T5.agent_direct_dao_act_proposal");
const duplicate = await call(agent, VOTER, "submit_pending", {
  proposal_id: p2, vote: "Approve", proposal_kind: callKind(61), receipt_hash: "duplicate-P2",
}, 30, "T5.agent_duplicate_submit_P2");
raw.tests.T5 = {
  restricted_method_attempts: restricted,
  transfer_attempt: transfer.record,
  direct_dao_attempt: directDao.record,
  duplicate_submit: duplicate.record,
  duplicate_submit_err_pending_exists: String(duplicate.record.error ?? "").includes("ERR_PENDING_EXISTS"),
};
sent = await call(seller, VOTER, "override_vote", { proposal_id: p2, vote: "Reject" }, 30, "T3.seller_override_P2");
if (sent.record.error) throw new Error(`P2 override failed: ${sent.record.error}`);
await waitDeadline(BigInt(p2Pending.deadline));
sent = await call(buyer, VOTER, "cast", { proposal_id: p2 }, 220, "T3.permissionless_cast_P2");
raw.tests.T3.final_cast = sent.record;
raw.tests.T3.proposal_after_cast = await view(DAO, "get_proposal", { id: p2 });
raw.tests.T3.results_after_cast = await view(VOTER, "get_results");
saveRaw();

const p3 = await proposal("P3", 62);
sent = await call(agent, VOTER, "submit_pending", {
  proposal_id: p3, vote: "Approve", proposal_kind: callKind(62), receipt_hash: "voter-spike-P3",
}, 30, "T4.agent_submit_P3");
if (sent.record.error) throw new Error(`P3 submit failed: ${sent.record.error}`);
const p3Submit = sent.record;
const p3Pending = await view(VOTER, "get_pending", { proposal_id: p3 });
const p3Cancel = await call(seller, VOTER, "cancel", { proposal_id: p3 }, 30, "T4.seller_cancel_P3");
raw.tests.T4 = { submit: p3Submit, pending_before_cancel: p3Pending, cancel: p3Cancel.record };
await waitDeadline(BigInt(p3Pending.deadline));
sent = await call(buyer, VOTER, "cast", { proposal_id: p3 }, 220, "T4.cast_after_cancel_P3");
raw.tests.T4.cast_after_deadline = sent.record;
raw.tests.T4.err_no_pending = String(sent.record.error ?? "").includes("ERR_NO_PENDING");
saveRaw();

const p4 = await proposal("P4", 63);
sent = await call(agent, VOTER, "submit_pending", {
  proposal_id: p4, vote: "Approve", proposal_kind: callKind(63), receipt_hash: "voter-spike-P4",
}, 30, "T6.agent_submit_P4");
if (sent.record.error) throw new Error(`P4 submit failed: ${sent.record.error}`);
const p4Submit = sent.record;
const p4Pending = await view(VOTER, "get_pending", { proposal_id: p4 });
const controllerChange = await call(owner, VOTER, "set_controller", { new_controller: BUYER }, 30, "T6.admin_set_controller_buyer");
raw.tests.T6 = { submit: p4Submit, pending_before_resale: p4Pending, set_controller: controllerChange.record };

const p5 = await proposal("P5", 64);
const remove = await call(owner, WEIGHT, "remove_weight", { dao: DAO, account: VOTER, amount: "1" }, 100, "T7.remove_voter_weight");
if (remove.record.error) throw new Error(`weight removal failed: ${remove.record.error}`);
sent = await call(buyer, VOTER, "member_vote", {
  proposal_id: p5, vote: "Approve", proposal_kind: callKind(64),
}, 220, "T7.buyer_member_vote_without_weight");
raw.tests.T7 = {
  remove_weight: remove.record,
  member_vote: sent.record,
  results: await view(VOTER, "get_results"),
  dao_proposal: await view(DAO, "get_proposal", { id: p5 }),
  voter_weight_after_removal: await view(DAO, "delegation_balance_of", { account_id: VOTER }),
};
const restore = await call(owner, WEIGHT, "add_weight", { dao: DAO, account: VOTER, amount: "1" }, 100, "T7.restore_voter_weight");
if (restore.record.error) throw new Error(`weight restoration failed: ${restore.record.error}`);
raw.tests.T7.restore_weight = restore.record;
saveRaw();

await waitDeadline(BigInt(p4Pending.deadline));
sent = await call(buyer, VOTER, "cast", { proposal_id: p4 }, 220, "T6.cast_after_resale_P4");
raw.tests.T6.cast_after_deadline = sent.record;
raw.tests.T6.cast_err_no_pending = String(sent.record.error ?? "").includes("ERR_NO_PENDING");
raw.tests.T6.pending_after_controller_change = await view(VOTER, "get_pending", { proposal_id: p4 });
raw.tests.T6.seller_override = (await call(seller, VOTER, "override_vote", { proposal_id: p4, vote: "Reject" }, 30, "T6.seller_override_after_resale")).record;
raw.tests.T6.seller_member_vote = (await call(seller, VOTER, "member_vote", {
  proposal_id: p4, vote: "Approve", proposal_kind: callKind(63),
}, 220, "T6.seller_member_vote_after_resale")).record;
raw.tests.T6.buyer_member_vote_P4 = (await call(buyer, VOTER, "member_vote", {
  proposal_id: p4, vote: "Approve", proposal_kind: callKind(63),
}, 220, "T6.buyer_member_vote_P4")).record;
raw.tests.T6.buyer_duplicate_vote_P1 = (await call(buyer, VOTER, "member_vote", {
  proposal_id: p1, vote: "Reject", proposal_kind: callKind(60),
}, 220, "T6.buyer_member_vote_already_voted_P1")).record;
raw.tests.T6.proposal_P1 = await view(DAO, "get_proposal", { id: p1 });
raw.tests.T6.proposal_P4 = await view(DAO, "get_proposal", { id: p4 });
raw.tests.T6.results = await view(VOTER, "get_results");

const keysBefore = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: VOTER }, raw.rpc_calls);
raw.views.voter_access_keys_before_delete = keysBefore.result.keys.map((key) => ({
  public_key: key.public_key,
  permission: key.access_key.permission,
  nonce: key.access_key.nonce,
}));
const deleted = await send(voterFull, VOTER, actionCreators.deleteKey(voterFull.publicKey), "T8.delete_voter_full_access_key");
const keysAfter = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: VOTER }, raw.rpc_calls);
raw.tests.T8 = {
  delete_full_access_key: deleted.record,
  access_keys_after_delete: keysAfter.result.keys.map((key) => ({
    public_key: key.public_key,
    permission: key.access_key.permission,
    nonce: key.access_key.nonce,
  })),
  only_agent_key_remains: keysAfter.result.keys.length === 1 && keysAfter.result.keys[0].public_key === pair.getPublicKey().toString(),
};

raw.views.final_controller = await view(VOTER, "get_controller");
raw.views.final_total_supply = await view(DAO, "delegation_total_supply");
raw.views.final_voter_weight = await view(DAO, "delegation_balance_of", { account_id: VOTER });
raw.views.final_seller_weight = await view(DAO, "delegation_balance_of", { account_id: SELLER });
raw.views.final_buyer_weight = await view(DAO, "delegation_balance_of", { account_id: BUYER });
raw.views.final_voter_balance = await accountState(VOTER, "final", raw.rpc_calls);
raw.views.final_owner_balance = await accountState(OWNER, "final", raw.rpc_calls);
raw.views.final_dao_balance = await accountState(DAO, "final", raw.rpc_calls);
raw.views.final_weight_proxy_balance = await accountState(WEIGHT, "final", raw.rpc_calls);
raw.views.voter_storage_usage_bytes = raw.views.final_voter_balance.storage_usage;
raw.views.voter_storage_locked_yocto = String(BigInt(raw.views.voter_storage_usage_bytes) * 10n ** 19n);
raw.views.voter_storage_locked_near = (Number(raw.views.voter_storage_locked_yocto) / Number(YOCTO)).toString();
raw.metadata.finished_utc = new Date().toISOString();
saveRaw();
console.log(JSON.stringify({
  tests: Object.keys(raw.tests),
  txs: raw.transactions.map((item) => ({ label: item.label, hash: item.attempted_hash, error: item.error ?? null })),
  results_path: RAW_PATH,
}));
