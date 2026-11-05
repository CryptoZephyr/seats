import fs from "node:fs";
import path from "node:path";
import { actionCreators } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/transactions/lib/esm/index.js";
import { KeyPair } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/crypto/lib/esm/index.js";
import { KeyPairSigner } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/signers/lib/esm/index.js";
import {
  accessKeyState,
  accountState,
  callKind,
  loadCredential,
  parseProposalId,
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
const RACE = `race.${OWNER}`;
const VOTER = "seatvoter-1793829831.testnet";
const SELLER = "seller-1793829831.testnet";
const BUYER = "buyer-1793829831.testnet";
const RPC = "https://test.rpc.fastnear.com";
const WASM_PATH = "/home/ubuntu/near-research/voter-spike/target/near/seat_voter.wasm";
const RAW_PATH = "/home/ubuntu/near-research/voter-spike/raw.json";
const SECRET_DIR = "/home/ubuntu/near-spike/secrets/seat-voter-spike";
const AGENT_KEY_PATH = path.join(SECRET_DIR, "agent-fc-key.json");
const YOCTO = 10n ** 24n;
const T_GAS = 10n ** 12n;
const DAO_CALL_GAS = 150n * T_GAS;
const CALLBACK_GAS = 20n * T_GAS;
const WINDOW_NS = 60_000_000_000n;

if (fs.existsSync(RAW_PATH)) {
  throw new Error("raw.json already exists, refusing to repeat transactions");
}

const raw = {
  metadata: {
    network: "testnet",
    rpc: RPC,
    dao: DAO,
    weight_proxy: WEIGHT,
    race_recorder: RACE,
    voter: VOTER,
    seller: SELLER,
    buyer: BUYER,
    wasm_path: WASM_PATH,
    override_window_ns: String(WINDOW_NS),
    started_utc: new Date().toISOString(),
  },
  transactions: [],
  tests: {},
  views: {},
  rpc_calls: [],
};

function saveRaw() {
  fs.writeFileSync(RAW_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(RAW_PATH, 0o600);
}

function extractOutcomes(result) {
  const transaction = result?.transaction_outcome?.outcome
    ? { id: result.transaction_outcome.id, ...result.transaction_outcome.outcome }
    : null;
  const receipts = (result?.receipts_outcome ?? []).map((item) => ({
    id: item.id,
    ...item.outcome,
  }));
  const sum = (items, field) => items.reduce(
    (total, item) => total + BigInt(item?.[field] ?? 0),
    0n,
  );
  const items = [transaction, ...receipts].filter(Boolean);
  return {
    transaction,
    receipts,
    total_gas_burnt: String(sum(items, "gas_burnt")),
    total_tokens_burnt: String(sum(items, "tokens_burnt")),
  };
}

async function sendAction(account, receiver, action, label, details = {}) {
  const prepared = await prepareTransaction(account, receiver, action, raw.rpc_calls);
  const entry = {
    label,
    signer_id: account.accountId,
    receiver_id: receiver,
    attempted_hash: prepared.hash,
    prepared_utc: prepared.prepared_utc,
    method: details.method ?? null,
    gas_attached: details.gas_attached ?? null,
    deposit_yocto: details.deposit_yocto ?? null,
    args: details.args ?? null,
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
    const final = await rpc("tx", {
      tx_hash: prepared.hash,
      sender_account_id: account.accountId,
      wait_until: "FINAL",
    }, raw.rpc_calls);
    result = final.result;
  } catch (error) {
    entry.finality_read_error = redactError(error);
  }
  const outcomes = extractOutcomes(result);
  entry.included = true;
  entry.final_status = result?.final_execution_status ?? null;
  entry.status = result?.status ?? null;
  entry.error = transactionError(result);
  entry.block_hash = result?.transaction_outcome?.block_hash ?? sent.record.block_hash;
  entry.block_height = result?.transaction_outcome?.outcome?.block_height
    ?? sent.record.block_height;
  entry.block_timestamp_nanosec = sent.record.block_timestamp_nanosec ?? null;
  entry.block_timestamp_utc = sent.record.block_timestamp_utc ?? null;
  entry.gas_burnt_total = outcomes.total_gas_burnt;
  entry.tokens_burnt_total = outcomes.total_tokens_burnt;
  entry.transaction_outcome = outcomes.transaction;
  entry.receipts_outcome = outcomes.receipts;
  entry.finished_utc = new Date().toISOString();
  entry.elapsed_ms = Number((Date.parse(entry.finished_utc) - Date.parse(entry.prepared_utc)));
  raw.transactions.push(entry);
  saveRaw();
  return { record: entry, result };
}

async function call(account, receiver, method, args, tgas, label, deposit = 0n) {
  const gas = BigInt(tgas) * T_GAS;
  return sendAction(
    account,
    receiver,
    actionCreators.functionCall(method, args, gas, deposit),
    label,
    {
      method,
      gas_attached: String(gas),
      deposit_yocto: String(deposit),
      args,
    },
  );
}

async function view(account, method, args = {}) {
  const response = await viewContract(account, method, args, "final", raw.rpc_calls);
  return response.value;
}

async function viewProposal(id) {
  return view(DAO, "get_proposal", { id });
}

async function createProposal(label, leg) {
  const before = await view(DAO, "get_last_proposal_id");
  const priorId = Number(before);
  const proposal = {
    description: `voter-spike: ${label}`,
    kind: callKind(leg),
  };
  const sent = await call(
    loadCredential(OWNER),
    DAO,
    "add_proposal",
    { proposal },
    60,
    `${label}.add_proposal`,
  );
  if (sent.record.error) {
    throw new Error(`${label} add_proposal failed: ${sent.record.error}`);
  }
  const id = parseProposalId(sent.result) ?? Number(await view(DAO, "get_last_proposal_id"));
  if (!Number.isSafeInteger(id) || id <= priorId) {
    throw new Error(`${label} proposal ID did not advance`);
  }
  raw.tests[label] = {
    proposal_id: id,
    race_leg: leg,
    proposal,
    tx_hash: sent.record.attempted_hash,
  };
  saveRaw();
  return id;
}

async function waitUntilChainTimestamp(targetNs) {
  while (true) {
    const response = await rpc("block", { finality: "final" }, raw.rpc_calls);
    const observed = BigInt(response.result.header.timestamp_nanosec);
    raw.views.last_final_timestamp_nanosec = String(observed);
    if (observed >= targetNs) {
      return String(observed);
    }
    saveRaw();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function errorContains(record, expected) {
  return String(record?.error ?? "").includes(expected);
}

const ownerAccount = loadCredential(OWNER);
const voterFullAccess = loadCredential(VOTER);
const sellerAccount = loadCredential(SELLER);
const buyerAccount = loadCredential(BUYER);
const agentPair = KeyPair.fromRandom("ed25519");
const agentSecret = agentPair.toString();
const agentAccount = {
  accountId: VOTER,
  publicKey: agentPair.getPublicKey(),
  signer: KeyPairSigner.fromSecretKey(agentSecret),
  nonce: null,
};

fs.mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(SECRET_DIR, 0o700);
fs.writeFileSync(AGENT_KEY_PATH, JSON.stringify({
  account_id: VOTER,
  private_key: agentSecret,
  public_key: agentPair.getPublicKey().toString(),
}), { mode: 0o600 });
fs.chmodSync(AGENT_KEY_PATH, 0o600);
raw.metadata.agent_key_path = AGENT_KEY_PATH;
raw.metadata.agent_key_file_mode = "0600";

raw.views.initial_owner = await accountState(OWNER, "final", raw.rpc_calls);
raw.views.initial_dao = await accountState(DAO, "final", raw.rpc_calls);
raw.views.initial_weight_proxy = await accountState(WEIGHT, "final", raw.rpc_calls);
raw.views.initial_total_supply = await view(DAO, "delegation_total_supply");
raw.views.preexisting_rookie_weight = await view(DAO, "delegation_balance_of", {
  account_id: "rookie1.weight.zspike-1793094130.testnet",
});
raw.views.seller_weight = await view(DAO, "delegation_balance_of", { account_id: SELLER });
raw.views.buyer_weight = await view(DAO, "delegation_balance_of", { account_id: BUYER });
raw.views.race_actions_before = await view(RACE, "get_actions");
const usedLegs = new Set(raw.views.race_actions_before.map((item) => Number(item.leg)));
for (const leg of [60, 61, 62, 63, 64]) {
  if (usedLegs.has(leg)) throw new Error(`race leg ${leg} was already used`);
}
saveRaw();

const wasm = fs.readFileSync(WASM_PATH);
raw.metadata.wasm_size_bytes = wasm.length;
raw.metadata.wasm_sha256_hex = "6b9294a50cd3f13f19d7e99414211c2bc649d12f085f7d390f28f54ea20c14d4";

let action = actionCreators.deployContract(wasm);
let sent = await sendAction(voterFullAccess, VOTER, action, "deploy_contract");
if (sent.record.error) throw new Error(`deploy failed: ${sent.record.error}`);

sent = await call(voterFullAccess, VOTER, "new", {
  dao: DAO,
  admin: OWNER,
  controller: SELLER,
  window_ns: Number(WINDOW_NS),
}, 50, "initialize_contract");
if (sent.record.error) throw new Error(`initialization failed: ${sent.record.error}`);

const agentAllowance = YOCTO / 4n;
action = actionCreators.addKey(
  agentPair.getPublicKey(),
  actionCreators.functionCallAccessKey(VOTER, ["submit_pending"], agentAllowance),
);
sent = await sendAction(voterFullAccess, VOTER, action, "add_agent_function_call_key", {
  method: "addKey",
  args: {
    receiver_id: VOTER,
    method_names: ["submit_pending"],
    allowance_yocto: String(agentAllowance),
  },
});
if (sent.record.error) throw new Error(`agent key addition failed: ${sent.record.error}`);
raw.views.agent_access_key = await accessKeyState(
  VOTER,
  agentPair.getPublicKey().toString(),
  "final",
  raw.rpc_calls,
);

raw.contract = {
  controller: await view(VOTER, "get_controller"),
  initial_results: await view(VOTER, "get_results"),
  account: await accountState(VOTER, "final", raw.rpc_calls),
};
raw.contract.storage_usage_bytes = raw.contract.account.storage_usage;
raw.contract.storage_locked_yocto = String(BigInt(raw.contract.account.storage_usage) * 10n ** 19n);
raw.contract.storage_locked_near = (Number(raw.contract.storage_locked_yocto) / Number(YOCTO)).toString();

const registerWeight = await call(ownerAccount, WEIGHT, "register", {
  dao: DAO,
  account: VOTER,
}, 100, "T1.register_voter_weight");
if (registerWeight.record.error) throw new Error(`weight registration failed: ${registerWeight.record.error}`);
const addWeight = await call(ownerAccount, WEIGHT, "add_weight", {
  dao: DAO,
  account: VOTER,
  amount: "1",
}, 100, "T1.add_voter_weight");
if (addWeight.record.error) throw new Error(`weight addition failed: ${addWeight.record.error}`);
raw.tests.T1 = {
  register: registerWeight.record,
  add_weight: addWeight.record,
  voter_weight: await view(DAO, "delegation_balance_of", { account_id: VOTER }),
  total_supply: await view(DAO, "delegation_total_supply"),
  voter_balance: await accountState(VOTER, "final", raw.rpc_calls),
};
saveRaw();

const p1 = await createProposal("P1", 60);
sent = await call(sellerAccount, VOTER, "member_vote", {
  proposal_id: p1,
  vote: "Approve",
  proposal_kind: callKind(60),
}, 220, "T2.seller_member_vote_P1");
raw.tests.T2 = {
  tx: sent.record,
  proposal: await viewProposal(p1),
  results: await view(VOTER, "get_results"),
};
saveRaw();

const p2 = await createProposal("P2", 61);
sent = await call(agentAccount, VOTER, "submit_pending", {
  proposal_id: p2,
  vote: "Approve",
  proposal_kind: callKind(61),
  receipt_hash: "voter-spike-P2",
}, 30, "T3.agent_submit_P2");
if (sent.record.error) throw new Error(`P2 submit failed: ${sent.record.error}`);
const p2Pending = await view(VOTER, "get_pending", { proposal_id: p2 });
sent = await call(buyerAccount, VOTER, "cast", { proposal_id: p2 }, 220, "T3.immediate_cast_P2");
raw.tests.T3 = {
  submit: raw.transactions.at(-2),
  pending_after_submit: p2Pending,
  early_cast: sent.record,
  early_cast_has_dao_receipt: sent.record.receipts_outcome?.some((item) => item.executor_id === DAO) ?? false,
};
raw.tests.T3.early_cast_err_too_early = errorContains(sent.record, "ERR_TOO_EARLY");

const restrictedAttempts = [];
for (const [method, args] of [
  ["override_vote", { proposal_id: p2, vote: "Reject" }],
  ["cancel", { proposal_id: p2 }],
  ["set_controller", { new_controller: BUYER }],
  ["member_vote", { proposal_id: p2, vote: "Approve", proposal_kind: callKind(61) }],
]) {
  const attempt = await call(agentAccount, VOTER, method, args, 30, `T5.agent_${method}`);
  restrictedAttempts.push(attempt.record);
}
const transferAttempt = await sendAction(
  agentAccount,
  BUYER,
  actionCreators.transfer(1n),
  "T5.agent_transfer",
  { method: "Transfer", deposit_yocto: "1" },
);
const directDaoAttempt = await call(agentAccount, DAO, "act_proposal", {
  id: p2,
  action: "VoteApprove",
  proposal: callKind(61),
  memo: null,
}, 30, "T5.agent_direct_dao_act_proposal");
const duplicateSubmit = await call(agentAccount, VOTER, "submit_pending", {
  proposal_id: p2,
  vote: "Approve",
  proposal_kind: callKind(61),
  receipt_hash: "duplicate-P2",
}, 30, "T5.agent_duplicate_submit_P2");
raw.tests.T5 = {
  restricted_method_attempts: restrictedAttempts,
  transfer_attempt: transferAttempt.record,
  direct_dao_attempt: directDaoAttempt.record,
  duplicate_submit: duplicateSubmit.record,
  duplicate_submit_err_pending_exists: errorContains(duplicateSubmit.record, "ERR_PENDING_EXISTS"),
};
saveRaw();

sent = await call(sellerAccount, VOTER, "override_vote", {
  proposal_id: p2,
  vote: "Reject",
}, 30, "T3.seller_override_P2");
if (sent.record.error) throw new Error(`P2 override failed: ${sent.record.error}`);
const p2Deadline = BigInt(p2Pending.deadline);
raw.tests.T3.timestamp_before_cast = await waitUntilChainTimestamp(p2Deadline);
sent = await call(buyerAccount, VOTER, "cast", { proposal_id: p2 }, 220, "T3.permissionless_cast_P2");
raw.tests.T3.final_cast = sent.record;
raw.tests.T3.proposal_after_cast = await viewProposal(p2);
raw.tests.T3.results_after_cast = await view(VOTER, "get_results");
saveRaw();

const p3 = await createProposal("P3", 62);
sent = await call(agentAccount, VOTER, "submit_pending", {
  proposal_id: p3,
  vote: "Approve",
  proposal_kind: callKind(62),
  receipt_hash: "voter-spike-P3",
}, 30, "T4.agent_submit_P3");
if (sent.record.error) throw new Error(`P3 submit failed: ${sent.record.error}`);
const p3SubmitRecord = sent.record;
const p3Pending = await view(VOTER, "get_pending", { proposal_id: p3 });
sent = await call(sellerAccount, VOTER, "cancel", { proposal_id: p3 }, 30, "T4.seller_cancel_P3");
if (sent.record.error) throw new Error(`P3 cancel failed: ${sent.record.error}`);
raw.tests.T4 = { submit: p3SubmitRecord, pending_before_cancel: p3Pending, cancel: sent.record };
await waitUntilChainTimestamp(BigInt(p3Pending.deadline));
sent = await call(buyerAccount, VOTER, "cast", { proposal_id: p3 }, 220, "T4.cast_after_cancel_P3");
raw.tests.T4.cast_after_deadline = sent.record;
raw.tests.T4.err_no_pending = errorContains(sent.record, "ERR_NO_PENDING");

const p4 = await createProposal("P4", 63);
sent = await call(agentAccount, VOTER, "submit_pending", {
  proposal_id: p4,
  vote: "Approve",
  proposal_kind: callKind(63),
  receipt_hash: "voter-spike-P4",
}, 30, "T6.agent_submit_P4");
if (sent.record.error) throw new Error(`P4 submit failed: ${sent.record.error}`);
const p4Pending = await view(VOTER, "get_pending", { proposal_id: p4 });
const controllerChange = await call(ownerAccount, VOTER, "set_controller", {
  new_controller: BUYER,
}, 30, "T6.admin_set_controller_buyer");
if (controllerChange.record.error) throw new Error(`controller change failed: ${controllerChange.record.error}`);
raw.tests.T6 = { submit: sent.record, pending_before_resale: p4Pending, set_controller: controllerChange.record };

const p5 = await createProposal("P5", 64);
const removeWeight = await call(ownerAccount, WEIGHT, "remove_weight", {
  dao: DAO,
  account: VOTER,
  amount: "1",
}, 100, "T7.remove_voter_weight");
raw.tests.T7 = { remove_weight: removeWeight.record };
if (removeWeight.record.error) throw new Error(`weight removal failed: ${removeWeight.record.error}`);
sent = await call(buyerAccount, VOTER, "member_vote", {
  proposal_id: p5,
  vote: "Approve",
  proposal_kind: callKind(64),
}, 220, "T7.buyer_member_vote_without_weight");
raw.tests.T7.member_vote = sent.record;
raw.tests.T7.result_after_failure = await view(VOTER, "get_results");
raw.tests.T7.dao_proposal_after_failure = await viewProposal(p5);
raw.tests.T7.delegation_weight_after_removal = await view(DAO, "delegation_balance_of", {
  account_id: VOTER,
});
const restoreWeight = await call(ownerAccount, WEIGHT, "add_weight", {
  dao: DAO,
  account: VOTER,
  amount: "1",
}, 100, "T7.restore_voter_weight");
raw.tests.T7.restore_weight = restoreWeight.record;
if (restoreWeight.record.error) throw new Error(`weight restoration failed: ${restoreWeight.record.error}`);
saveRaw();

await waitUntilChainTimestamp(BigInt(p4Pending.deadline));
sent = await call(buyerAccount, VOTER, "cast", { proposal_id: p4 }, 220, "T6.cast_after_resale_P4");
raw.tests.T6.cast_after_deadline = sent.record;
raw.tests.T6.cast_err_no_pending = errorContains(sent.record, "ERR_NO_PENDING");
raw.tests.T6.pending_after_controller_change = await view(VOTER, "get_pending", { proposal_id: p4 });
const sellerOverride = await call(sellerAccount, VOTER, "override_vote", {
  proposal_id: p4,
  vote: "Reject",
}, 30, "T6.seller_override_after_resale");
const sellerMemberVote = await call(sellerAccount, VOTER, "member_vote", {
  proposal_id: p4,
  vote: "Approve",
  proposal_kind: callKind(63),
}, 220, "T6.seller_member_vote_after_resale");
const buyerMemberVote = await call(buyerAccount, VOTER, "member_vote", {
  proposal_id: p4,
  vote: "Approve",
  proposal_kind: callKind(63),
}, 220, "T6.buyer_member_vote_P4");
const buyerDuplicateVote = await call(buyerAccount, VOTER, "member_vote", {
  proposal_id: p1,
  vote: "Reject",
  proposal_kind: callKind(60),
}, 220, "T6.buyer_member_vote_already_voted_P1");
raw.tests.T6.seller_override = sellerOverride.record;
raw.tests.T6.seller_member_vote = sellerMemberVote.record;
raw.tests.T6.buyer_member_vote_P4 = buyerMemberVote.record;
raw.tests.T6.buyer_duplicate_vote_P1 = buyerDuplicateVote.record;
raw.tests.T6.proposal_P1_after_duplicate_attempt = await viewProposal(p1);
raw.tests.T6.proposal_P4_after_buyer_vote = await viewProposal(p4);
raw.tests.T6.results = await view(VOTER, "get_results");
raw.views.final_controller = await view(VOTER, "get_controller");

const voterKeysBeforeDelete = await rpc("query", {
  request_type: "view_access_key_list",
  finality: "final",
  account_id: VOTER,
}, raw.rpc_calls);
raw.views.voter_access_keys_before_delete = voterKeysBeforeDelete.result.keys.map((item) => ({
  public_key: item.public_key,
  permission: item.access_key.permission,
  nonce: item.access_key.nonce,
}));
const deleteFullKey = await sendAction(
  voterFullAccess,
  VOTER,
  actionCreators.deleteKey(voterFullAccess.publicKey),
  "T8.delete_voter_full_access_key",
);
raw.tests.T8 = { delete_full_access_key: deleteFullKey.record };
const voterKeysAfterDelete = await rpc("query", {
  request_type: "view_access_key_list",
  finality: "final",
  account_id: VOTER,
}, raw.rpc_calls);
raw.tests.T8.access_keys_after_delete = voterKeysAfterDelete.result.keys.map((item) => ({
  public_key: item.public_key,
  permission: item.access_key.permission,
  nonce: item.access_key.nonce,
}));
raw.tests.T8.only_agent_key_remains = voterKeysAfterDelete.result.keys.length === 1
  && voterKeysAfterDelete.result.keys[0].public_key === agentPair.getPublicKey().toString();

raw.views.final_total_supply = await view(DAO, "delegation_total_supply");
raw.views.final_voter_weight = await view(DAO, "delegation_balance_of", { account_id: VOTER });
raw.views.final_seller_weight = await view(DAO, "delegation_balance_of", { account_id: SELLER });
raw.views.final_buyer_weight = await view(DAO, "delegation_balance_of", { account_id: BUYER });
raw.views.final_voter_balance = await accountState(VOTER, "final", raw.rpc_calls);
raw.views.final_owner_balance = await accountState(OWNER, "final", raw.rpc_calls);
raw.views.final_dao_balance = await accountState(DAO, "final", raw.rpc_calls);
raw.views.voter_storage_usage_bytes = raw.views.final_voter_balance.storage_usage;
raw.views.voter_storage_locked_yocto = String(
  BigInt(raw.views.voter_storage_usage_bytes) * 10n ** 19n,
);
raw.views.voter_storage_locked_near = (
  Number(raw.views.voter_storage_locked_yocto) / Number(YOCTO)
).toString();
raw.metadata.finished_utc = new Date().toISOString();
saveRaw();
console.log(JSON.stringify({
  voter: VOTER,
  seller: SELLER,
  buyer: BUYER,
  transactions: raw.transactions.map(({ label, attempted_hash, error, gas_burnt_total, tokens_burnt_total }) => ({
    label,
    hash: attempted_hash,
    error,
    gas_burnt: gas_burnt_total ?? null,
    tokens_burnt: tokens_burnt_total ?? null,
  })),
  results_path: RAW_PATH,
}));
