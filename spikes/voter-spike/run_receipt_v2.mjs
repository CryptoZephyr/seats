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
  parseProposalId,
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
const RACE = `race.${OWNER}`;
const VOTER = "seatvoter-v2a-1793831906.testnet";
const SELLER = "seller-1793829831.testnet";
const RAW_PATH = "/home/ubuntu/near-research/voter-spike/raw-v2.json";
const SECRET_DIR = "/home/ubuntu/near-spike/secrets/seat-voter-spike-v2";
const FIXTURE_PATH = "/home/ubuntu/near-research/voter-spike/tests/fixtures/nearai_receipt_v2.json";
const T_GAS = 10n ** 12n;
const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
const model = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
raw.receipt = {
  source: FIXTURE_PATH,
  fixture,
  offchain_verification: {
    signature_verified: fixture.signing_address === fixture.recovered_address,
    signing_address: fixture.signing_address,
    recovered_address: fixture.recovered_address,
    response_body_bytes: fixture.response_body_bytes,
  },
  onchain: {},
};
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

function extractOutcomes(result) {
  const transaction = result?.transaction_outcome?.outcome
    ? { id: result.transaction_outcome.id, ...result.transaction_outcome.outcome }
    : null;
  const receipts = (result?.receipts_outcome ?? []).map((item) => ({
    id: item.id,
    ...item.outcome,
  }));
  const items = [transaction, ...receipts].filter(Boolean);
  const total = (field) => items.reduce((sum, item) => sum + BigInt(item?.[field] ?? 0n), 0n).toString();
  return { transaction, receipts, gas_burnt_total: total("gas_burnt"), tokens_burnt_total: total("tokens_burnt") };
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
  const outcomes = extractOutcomes(result);
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
    ...outcomes,
    block_height: sent.record.block_height,
    block_timestamp_utc: sent.record.block_timestamp_utc,
  };
  raw.dao_test.transactions.push(record);
  saveJson(RAW_PATH, raw);
  return { record, result };
}

async function call(account, receiver, method, args, tgas, label) {
  const gas = BigInt(tgas) * T_GAS;
  return send(
    account,
    receiver,
    actionCreators.functionCall(method, args, gas, 0n),
    label,
    method,
    args,
    gas,
  );
}

async function createProposal(owner, label, leg) {
  const before = Number((await viewContract(DAO, "get_last_proposal_id", {}, "final")).value);
  const proposal = {
    description: `voter-spike-v2: ${label}`,
    kind: {
      FunctionCall: {
        receiver_id: RACE,
        actions: [{
          method_name: "apply_action",
          args: Buffer.from(JSON.stringify({ leg, action: "boost" })).toString("base64"),
          deposit: "0",
          gas: String(30n * T_GAS),
        }],
      },
    },
  };
  const result = await call(owner, DAO, "add_proposal", { proposal }, 60, `create_${label}_proposal`);
  if (result.record.error) throw new Error(`${label} proposal: ${result.record.error}`);
  const id = parseProposalId(result.result)
    ?? Number((await viewContract(DAO, "get_last_proposal_id", {}, "final")).value) - 1;
  if (!Number.isSafeInteger(id) || id < before) throw new Error(`${label} proposal ID did not advance`);
  return { id, proposal, tx: result.record };
}

const owner = loadCredential(OWNER);
const voter = loadV2Credential(VOTER, "voter-a.json");
const agent = loadV2Credential(VOTER, "voter-a-agent.json");
const seller = loadCredential(SELLER);

if (!raw.receipt.offchain_verification.signature_verified) {
  throw new Error("off-chain signer recovery did not match the fresh attestation signer");
}
if (fixture.proposal_id !== raw.dao_test.proposal.proposal_id) {
  throw new Error("receipt proposal ID does not match the fresh DAO proposal");
}

const signerArgs = { address_hex: fixture.signing_address, model };
const signerSet = await call(owner, VOTER, "set_model_signer", signerArgs, 30, "set_model_signer");
if (signerSet.record.error) throw new Error(`set_model_signer: ${signerSet.record.error}`);
raw.receipt.onchain.set_model_signer = signerSet.record;

const replayProposal = await createProposal(owner, "receipt replay target", 1001);
raw.receipt.onchain.replay_proposal = {
  proposal_id: replayProposal.id,
  tx: replayProposal.tx,
  proposal: replayProposal.proposal,
};
saveJson(RAW_PATH, raw);

const validArgs = {
  proposal_id: fixture.proposal_id,
  proposal_kind: raw.dao_test.proposal.proposal.kind,
  model,
  request_hash: fixture.request_hash,
  response_body: fixture.response_body,
  signature: fixture.signature,
};
const valid = await call(agent, VOTER, "submit_pending", validArgs, 100, "valid_full_body_submit_pending");
if (valid.record.error) throw new Error(`valid receipt submission: ${valid.record.error}`);
const pending = (await viewContract(VOTER, "get_pending", { proposal_id: fixture.proposal_id }, "final")).value;
raw.receipt.onchain.valid_submit = valid.record;
raw.receipt.onchain.pending_after_valid_submit = pending;
raw.receipt.onchain.submit_response_body_bytes = fixture.response_body_bytes;
saveJson(RAW_PATH, raw);
if (pending.vote !== "Reject") throw new Error(`signed receipt vote was ${pending.vote}, expected Reject`);

const tamperedBody = `[${fixture.response_body.slice(1)}`;
const tampered = await call(agent, VOTER, "submit_pending", {
  ...validArgs,
  response_body: tamperedBody,
}, 100, "tampered_response_submit_pending");
raw.receipt.onchain.tampered_submit = tampered.record;
if (!String(tampered.record.error).includes("ERR_WRONG_SIGNER")
  && !String(tampered.record.error).includes("ERR_BAD_SIGNATURE")) {
  throw new Error(`tampered body failed unexpectedly: ${tampered.record.error}`);
}

const replay = await call(agent, VOTER, "submit_pending", {
  ...validArgs,
  proposal_id: replayProposal.id,
  proposal_kind: replayProposal.proposal.kind,
}, 100, "receipt_replay_submit_pending");
raw.receipt.onchain.replay_submit = replay.record;
if (!String(replay.record.error).includes("ERR_RECEIPT_USED")) {
  throw new Error(`receipt replay failed unexpectedly: ${replay.record.error}`);
}
saveJson(RAW_PATH, raw);

const overrideApprove = await call(seller, VOTER, "override_vote", {
  proposal_id: fixture.proposal_id,
  vote: "Approve",
}, 30, "override_inside_window_approve");
if (overrideApprove.record.error) throw new Error(`inside-window override: ${overrideApprove.record.error}`);
const overrideReject = await call(seller, VOTER, "override_vote", {
  proposal_id: fixture.proposal_id,
  vote: "Reject",
}, 30, "override_inside_window_restore_reject");
if (overrideReject.record.error) throw new Error(`inside-window restore override: ${overrideReject.record.error}`);
raw.receipt.onchain.inside_window_overrides = [overrideApprove.record, overrideReject.record];
saveJson(RAW_PATH, raw);

const deadline = BigInt(pending.deadline);
let observed = 0n;
while (observed < deadline) {
  const block = await rpc("block", { finality: "final" }, raw.rpc_calls);
  observed = BigInt(block.result.header.timestamp_nanosec);
  if (observed < deadline) await sleep(1_000);
}
raw.receipt.onchain.deadline_timestamp_ns = String(deadline);
raw.receipt.onchain.cast_attempt_timestamp_ns = String(observed);

const lateOverride = await call(seller, VOTER, "override_vote", {
  proposal_id: fixture.proposal_id,
  vote: "Approve",
}, 30, "override_after_deadline");
raw.receipt.onchain.late_override = lateOverride.record;
if (!String(lateOverride.record.error).includes("ERR_WINDOW_CLOSED")) {
  throw new Error(`late override failed unexpectedly: ${lateOverride.record.error}`);
}
const lateCancel = await call(seller, VOTER, "cancel", {
  proposal_id: fixture.proposal_id,
}, 30, "cancel_after_deadline");
raw.receipt.onchain.late_cancel = lateCancel.record;
if (!String(lateCancel.record.error).includes("ERR_WINDOW_CLOSED")) {
  throw new Error(`late cancel failed unexpectedly: ${lateCancel.record.error}`);
}

const cast = await call(seller, VOTER, "cast", {
  proposal_id: fixture.proposal_id,
}, 220, "public_cast_after_deadline");
if (cast.record.error) throw new Error(`public cast: ${cast.record.error}`);
raw.receipt.onchain.cast = cast.record;
raw.receipt.onchain.pending_after_cast = (await viewContract(VOTER, "get_pending", {
  proposal_id: fixture.proposal_id,
}, "final")).value;
raw.receipt.onchain.voter_results = (await viewContract(VOTER, "get_results", {}, "final")).value;
raw.receipt.onchain.dao_proposal_after_cast = (await viewContract(DAO, "get_proposal", {
  id: fixture.proposal_id,
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
if (deletion.record.error) throw new Error(`FullAccess key deletion: ${deletion.record.error}`);
const accessList = await rpc("query", {
  request_type: "view_access_key_list",
  finality: "final",
  account_id: VOTER,
}, raw.rpc_calls);
const remaining = accessList.result.keys.map((item) => {
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
raw.receipt.onchain.full_access_key_deletion = deletion.record;
raw.receipt.onchain.final_remaining_keys = remaining;
raw.receipt.onchain.final_voter_account = await accountState(VOTER, "final", raw.rpc_calls);
raw.receipt.onchain.final_owner_account = await accountState(OWNER, "final", raw.rpc_calls);
raw.receipt.onchain.final_weight = (await viewContract(DAO, "delegation_balance_of", {
  account_id: VOTER,
}, "final")).value;
saveJson(RAW_PATH, raw);

console.log(JSON.stringify({
  proposal_id: fixture.proposal_id,
  vote: pending.vote,
  response_body_bytes: fixture.response_body_bytes,
  valid_submit_hash: valid.record.hash,
  valid_submit_gas: valid.record.gas_burnt_total,
  valid_submit_tokens_burnt: valid.record.tokens_burnt_total,
  tampered_error: tampered.record.error,
  replay_error: replay.record.error,
  late_override_error: lateOverride.record.error,
  late_cancel_error: lateCancel.record.error,
  cast_hash: cast.record.hash,
  dao_votes: raw.receipt.onchain.dao_proposal_after_cast?.votes,
  remaining_keys: remaining,
  voter_storage_usage: raw.receipt.onchain.final_voter_account.storage_usage,
  owner_balance: raw.receipt.onchain.final_owner_account.amount,
}));
