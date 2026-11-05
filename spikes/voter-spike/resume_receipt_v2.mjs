import fs from "node:fs";
import {
  KeyPair,
} from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/crypto/lib/esm/index.js";
import {
  KeyPairSigner,
} from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/signers/lib/esm/index.js";
import {
  actionCreators,
} from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/transactions/lib/esm/index.js";
import {
  accountState,
  loadCredential,
  prepareTransaction,
  rpc,
  saveJson,
  sendPrepared,
  sleep,
  transactionError,
  viewContract,
} from "/home/ubuntu/near-spike/dao-latency/fc_key_common.mjs";

const OWNER = "zspike-1793094130.testnet";
const DAO = `dao.${OWNER}`;
const VOTER = "seatvoter-v2a-1793831906.testnet";
const SELLER = "seller-1793829831.testnet";
const RAW_PATH = "/home/ubuntu/near-research/voter-spike/raw-v2.json";
const SECRET_DIR = "/home/ubuntu/near-spike/secrets/seat-voter-spike-v2";
const T_GAS = 10n ** 12n;
const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
const fixture = JSON.parse(fs.readFileSync(
  "/home/ubuntu/near-research/voter-spike/tests/fixtures/nearai_receipt_v2.json",
  "utf8",
));
raw.receipt.onchain ??= {};
raw.dao_test.transactions ??= [];
raw.rpc_calls ??= [];

function loadV2Credential(accountId, fileName) {
  const data = JSON.parse(fs.readFileSync(`${SECRET_DIR}/${fileName}`, "utf8"));
  return {
    accountId,
    publicKey: KeyPair.fromString(data.private_key).getPublicKey(),
    signer: KeyPairSigner.fromSecretKey(data.private_key),
    nonce: null,
  };
}

async function send(account, receiver, action, label, method, args, gas) {
  const prepared = await prepareTransaction(account, receiver, action, raw.rpc_calls);
  const sent = await sendPrepared(prepared, raw.rpc_calls);
  await sent.blockPromise;
  const final = await rpc("tx", {
    tx_hash: prepared.hash,
    sender_account_id: account.accountId,
    wait_until: "FINAL",
  }, raw.rpc_calls);
  const result = final.result;
  const transaction = result?.transaction_outcome?.outcome
    ? { id: result.transaction_outcome.id, ...result.transaction_outcome.outcome }
    : null;
  const receipts = (result?.receipts_outcome ?? []).map((item) => ({
    id: item.id,
    ...item.outcome,
  }));
  const items = [transaction, ...receipts].filter(Boolean);
  const total = (field) => items.reduce((sum, item) => sum + BigInt(item?.[field] ?? 0n), 0n).toString();
  const record = {
    label,
    hash: prepared.hash,
    signer_id: account.accountId,
    receiver_id: receiver,
    method,
    args,
    gas_attached: String(gas),
    final_execution_status: result?.final_execution_status,
    status: result?.status,
    error: transactionError(result),
    gas_burnt_total: total("gas_burnt"),
    tokens_burnt_total: total("tokens_burnt"),
    transaction_outcome: transaction,
    receipts_outcome: receipts,
    block_height: sent.record.block_height,
    block_timestamp_utc: sent.record.block_timestamp_utc,
  };
  raw.dao_test.transactions.push(record);
  saveJson(RAW_PATH, raw);
  return record;
}

async function call(account, method, args, tgas, label) {
  const gas = BigInt(tgas) * T_GAS;
  return send(
    account,
    VOTER,
    actionCreators.functionCall(method, args, gas, 0n),
    label,
    method,
    args,
    gas,
  );
}

const agent = loadV2Credential(VOTER, "voter-a-agent.json");
const voter = loadV2Credential(VOTER, "voter-a.json");
const seller = loadCredential(SELLER);
const proposalId = fixture.proposal_id;
const replayId = raw.receipt.onchain.replay_proposal.proposal_id;
const validArgs = {
  proposal_id: proposalId,
  proposal_kind: raw.dao_test.proposal.proposal.kind,
  model: fixture.model,
  request_hash: fixture.request_hash,
  response_body: fixture.response_body,
  signature: fixture.signature,
};

const tampered = await call(agent, "submit_pending", {
  ...validArgs,
  proposal_id: replayId,
  proposal_kind: raw.receipt.onchain.replay_proposal.proposal.kind,
  response_body: `[${fixture.response_body.slice(1)}`,
}, 100, "tampered_body_on_fresh_proposal");
raw.receipt.onchain.tampered_submit = tampered;
if (!String(tampered.error).includes("ERR_WRONG_SIGNER")
  && !String(tampered.error).includes("ERR_BAD_SIGNATURE")) {
  saveJson(RAW_PATH, raw);
  throw new Error(`tampered response error: ${tampered.error}`);
}

const replay = await call(agent, "submit_pending", {
  ...validArgs,
  proposal_id: replayId,
  proposal_kind: raw.receipt.onchain.replay_proposal.proposal.kind,
}, 100, "receipt_replay_on_second_proposal");
raw.receipt.onchain.replay_submit = replay;
if (!String(replay.error).includes("ERR_RECEIPT_USED")) {
  saveJson(RAW_PATH, raw);
  throw new Error(`receipt replay error: ${replay.error}`);
}

const insideApprove = await call(seller, "override_vote", {
  proposal_id: proposalId,
  vote: "Approve",
}, 30, "override_inside_window_approve");
if (insideApprove.error) throw new Error(`inside-window override: ${insideApprove.error}`);
const insideReject = await call(seller, "override_vote", {
  proposal_id: proposalId,
  vote: "Reject",
}, 30, "override_inside_window_restore_reject");
if (insideReject.error) throw new Error(`inside-window restore: ${insideReject.error}`);
raw.receipt.onchain.inside_window_overrides = [insideApprove, insideReject];
saveJson(RAW_PATH, raw);

const pending = (await viewContract(VOTER, "get_pending", { proposal_id: proposalId }, "final")).value;
const deadline = BigInt(pending.deadline);
let observed = 0n;
while (observed < deadline) {
  const block = await rpc("block", { finality: "final" }, raw.rpc_calls);
  observed = BigInt(block.result.header.timestamp_nanosec);
  if (observed < deadline) await sleep(1_000);
}
raw.receipt.onchain.deadline_timestamp_ns = String(deadline);
raw.receipt.onchain.after_deadline_timestamp_ns = String(observed);

const lateOverride = await call(seller, "override_vote", {
  proposal_id: proposalId,
  vote: "Approve",
}, 30, "override_after_deadline");
raw.receipt.onchain.late_override = lateOverride;
if (!String(lateOverride.error).includes("ERR_WINDOW_CLOSED")) {
  saveJson(RAW_PATH, raw);
  throw new Error(`late override error: ${lateOverride.error}`);
}
const lateCancel = await call(seller, "cancel", {
  proposal_id: proposalId,
}, 30, "cancel_after_deadline");
raw.receipt.onchain.late_cancel = lateCancel;
if (!String(lateCancel.error).includes("ERR_WINDOW_CLOSED")) {
  saveJson(RAW_PATH, raw);
  throw new Error(`late cancel error: ${lateCancel.error}`);
}

const cast = await call(seller, "cast", { proposal_id: proposalId }, 220, "public_cast_after_deadline");
if (cast.error) throw new Error(`public cast: ${cast.error}`);
raw.receipt.onchain.cast = cast;
raw.receipt.onchain.voter_results = (await viewContract(VOTER, "get_results", {}, "final")).value;
raw.receipt.onchain.dao_proposal_after_cast = (await viewContract(DAO, "get_proposal", {
  id: proposalId,
}, "final")).value;

const deletion = await send(
  voter,
  VOTER,
  actionCreators.deleteKey(voter.publicKey),
  "delete_voter_full_access_key",
  "deleteKey",
  { key_permission: "FullAccess" },
  0n,
);
if (deletion.error) throw new Error(`FullAccess key deletion: ${deletion.error}`);
const accessList = await rpc("query", {
  request_type: "view_access_key_list",
  finality: "final",
  account_id: VOTER,
}, raw.rpc_calls);
raw.receipt.onchain.final_remaining_keys = accessList.result.keys.map((item) => {
  const permission = item.access_key.permission;
  return permission.FunctionCall
    ? {
      permission: "FunctionCall",
      receiver_id: permission.FunctionCall.receiver_id,
      method_names: permission.FunctionCall.method_names,
      allowance: permission.FunctionCall.allowance,
    }
    : { permission: "FullAccess" };
});
raw.receipt.onchain.full_access_key_deletion = deletion;
raw.receipt.onchain.final_voter_account = await accountState(VOTER, "final", raw.rpc_calls);
raw.receipt.onchain.final_owner_account = await accountState(OWNER, "final", raw.rpc_calls);
raw.receipt.onchain.final_weight = (await viewContract(DAO, "delegation_balance_of", {
  account_id: VOTER,
}, "final")).value;
saveJson(RAW_PATH, raw);

console.log(JSON.stringify({
  tampered_error: tampered.error,
  replay_error: replay.error,
  inside_window_overrides: [insideApprove.error, insideReject.error],
  late_override_error: lateOverride.error,
  late_cancel_error: lateCancel.error,
  cast_hash: cast.hash,
  dao_votes: raw.receipt.onchain.dao_proposal_after_cast?.votes,
  remaining_keys: raw.receipt.onchain.final_remaining_keys,
  storage_usage: raw.receipt.onchain.final_voter_account.storage_usage,
  owner_balance: raw.receipt.onchain.final_owner_account.amount,
}));
