import fs from "node:fs";
import { actionCreators } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/transactions/lib/esm/index.js";
import {
  accessKeyState,
  accountState,
  callKind,
  loadCredential,
  prepareTransaction,
  redactError,
  rpc,
  sendPrepared,
  transactionError,
  viewContract,
} from "/home/ubuntu/near-spike/dao-latency/fc_key_common.mjs";

const OWNER = "zspike-1793094130.testnet";
const DAO = `dao.${OWNER}`;
const WEIGHT = `weight.${OWNER}`;
const VOTER = "seatvoter-1793829831.testnet";
const SELLER = "seller-1793829831.testnet";
const BUYER = "buyer-1793829831.testnet";
const RAW_PATH = "/home/ubuntu/near-research/voter-spike/raw.json";
const T_GAS = 10n ** 12n;
const YOCTO = 10n ** 24n;
const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));

for (const label of [
  "T6.cast_old_P4",
  "T6.seller_override_old_P4",
  "T6.seller_member_vote_old_P4",
  "P6.add_proposal",
  "T6.buyer_member_vote_P6",
  "T6.buyer_member_vote_P1_again",
  "P7.add_proposal",
  "T7.remove_weight_retry1",
  "T7.buyer_member_vote_P7",
  "T7.restore_weight",
  "T8.delete_full_access_key",
]) {
  if (raw.transactions.some((tx) => tx.label === label)) throw new Error(`refusing to repeat ${label}`);
}

function saveRaw() {
  fs.writeFileSync(RAW_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(RAW_PATH, 0o600);
}

function signer(accountId) {
  return loadCredential(accountId);
}

function outcomes(result) {
  const tx = result?.transaction_outcome?.outcome
    ? { id: result.transaction_outcome.id, ...result.transaction_outcome.outcome }
    : null;
  const receipts = (result?.receipts_outcome ?? []).map((item) => ({ id: item.id, ...item.outcome }));
  const all = [tx, ...receipts].filter(Boolean);
  const sum = (field) => all.reduce((value, item) => value + BigInt(item?.[field] ?? 0), 0n);
  return { tx, receipts, gas: String(sum("gas_burnt")), tokens: String(sum("tokens_burnt")) };
}

async function send(account, receiver, action, label, details = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (account.accountId === OWNER) {
      const state = await accountState(OWNER, "final", raw.rpc_calls);
      if (BigInt(state.amount) < 300_000_000_000_000_000_000_000n) {
        throw new Error("owner balance floor of 0.3 NEAR would be breached");
      }
    }
    const key = await accessKeyState(account.accountId, account.publicKey.toString(), "final", raw.rpc_calls);
    account.nonce = BigInt(key.nonce);
    const prepared = await prepareTransaction(account, receiver, action, raw.rpc_calls);
    const entry = {
      label: attempt === 1 ? label : `${label}.nonce_retry`,
      signer_id: account.accountId,
      receiver_id: receiver,
      attempted_hash: prepared.hash,
      prepared_utc: prepared.prepared_utc,
      nonce_final_view: String(key.nonce),
      nonce_used: String(account.nonce),
      ...details,
    };
    let sent;
    try {
      sent = await sendPrepared(prepared, raw.rpc_calls);
    } catch (error) {
      lastError = redactError(error);
      entry.included = false;
      entry.error = lastError;
      entry.status = "RejectedBeforeInclusion";
      entry.finished_utc = new Date().toISOString();
      raw.transactions.push(entry);
      saveRaw();
      if (attempt === 1 && /nonce/i.test(lastError)) continue;
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
    entry.gas_burnt_total = detail.gas;
    entry.tokens_burnt_total = detail.tokens;
    entry.transaction_outcome = detail.tx;
    entry.receipts_outcome = detail.receipts;
    entry.finished_utc = new Date().toISOString();
    raw.transactions.push(entry);
    saveRaw();
    return { record: entry, result };
  }
  throw new Error(lastError ?? "send failed");
}

async function call(account, receiver, method, args, gasTgas, label) {
  return send(account, receiver, actionCreators.functionCall(
    method,
    args,
    BigInt(gasTgas) * T_GAS,
    0n,
  ), label, { method, args, gas_attached: String(BigInt(gasTgas) * T_GAS), deposit_yocto: "0" });
}

async function view(accountId, method, args = {}) {
  return (await viewContract(accountId, method, args, "final", raw.rpc_calls)).value;
}

async function addProposal(label, leg) {
  const id = Number(await view(DAO, "get_last_proposal_id"));
  const proposal = {
    description: `voter-spike: ${label}`,
    kind: callKind(leg),
  };
  const sent = await call(signer(OWNER), DAO, "add_proposal", { proposal }, 60, `${label}.add_proposal`);
  if (sent.record.error) throw new Error(`${label} proposal failed: ${sent.record.error}`);
  const created = await view(DAO, "get_proposal", { id });
  if (!created || Number(created.id) !== id) throw new Error(`${label} proposal ${id} not found at finality`);
  raw.tests[label] = { proposal_id: id, race_leg: leg, proposal, tx: sent.record, status_before_vote: created.status };
  saveRaw();
  return id;
}

async function requireProgress(id, label) {
  const proposal = await view(DAO, "get_proposal", { id });
  raw.views[`${label}_status_before_action`] = { id, status: proposal?.status ?? null };
  saveRaw();
  return proposal;
}

const preflight = {
  controller: await view(VOTER, "get_controller"),
  voter_weight: await view(DAO, "delegation_balance_of", { account_id: VOTER }),
  total_supply: await view(DAO, "delegation_total_supply"),
  p1: await view(DAO, "get_proposal", { id: 45 }),
  p4: await view(DAO, "get_proposal", { id: 48 }),
  p5: await view(DAO, "get_proposal", { id: 49 }),
  p4_pending: await view(VOTER, "get_pending", { proposal_id: 48 }),
};
raw.views.resume_preflight = preflight;
saveRaw();
if (preflight.controller !== BUYER) throw new Error(`controller changed unexpectedly: ${preflight.controller}`);

let sent = await call(signer(BUYER), VOTER, "cast", { proposal_id: 48 }, 220, "T6.cast_old_P4");
raw.tests.T6.cast_old_P4 = { tx: sent.record, err_no_pending: String(sent.record.error ?? "").includes("ERR_NO_PENDING") };
sent = await call(signer(SELLER), VOTER, "override_vote", { proposal_id: 48, vote: "Reject" }, 30, "T6.seller_override_old_P4");
raw.tests.T6.seller_override_old_P4 = sent.record;
sent = await call(signer(SELLER), VOTER, "member_vote", {
  proposal_id: 48, vote: "Approve", proposal_kind: callKind(63),
}, 220, "T6.seller_member_vote_old_P4");
raw.tests.T6.seller_member_vote_old_P4 = sent.record;

const actions = await view(`race.${OWNER}`, "get_actions");
const used = new Set(actions.map((action) => Number(action.leg)));
let p6Leg = 70;
while (used.has(p6Leg)) p6Leg += 1;
const p6 = await addProposal("P6", p6Leg);
let p6View = await requireProgress(p6, "P6");
sent = await call(signer(BUYER), VOTER, "member_vote", {
  proposal_id: p6, vote: "Approve", proposal_kind: p6View.kind,
}, 220, "T6.buyer_member_vote_P6");
raw.tests.T6.buyer_member_vote_P6 = {
  tx: sent.record,
  proposal: await view(DAO, "get_proposal", { id: p6 }),
  results: await view(VOTER, "get_results"),
};
sent = await call(signer(BUYER), VOTER, "member_vote", {
  proposal_id: 45, vote: "Reject", proposal_kind: preflight.p1.kind,
}, 220, "T6.buyer_member_vote_P1_again");
raw.tests.T6.buyer_member_vote_P1_again = {
  tx: sent.record,
  p1_status_before: preflight.p1.status,
  proposal: await view(DAO, "get_proposal", { id: 45 }),
  results: await view(VOTER, "get_results"),
};
saveRaw();

used.add(p6Leg);
let p7Leg = p6Leg + 1;
while (used.has(p7Leg)) p7Leg += 1;
const p7 = await addProposal("P7", p7Leg);
const p7View = await requireProgress(p7, "P7");
const remove = await call(signer(OWNER), WEIGHT, "remove_weight", {
  dao: DAO, account: VOTER, amount: "1",
}, 100, "T7.remove_weight_retry1");
raw.tests.T7 = { proposal_id: p7, proposal_status_before_vote: p7View.status, remove_weight: remove.record };
if (remove.record.error) throw new Error(`remove_weight failed: ${remove.record.error}`);
raw.tests.T7.weight_after_remove = await view(DAO, "delegation_balance_of", { account_id: VOTER });
sent = await call(signer(BUYER), VOTER, "member_vote", {
  proposal_id: p7, vote: "Approve", proposal_kind: p7View.kind,
}, 220, "T7.buyer_member_vote_P7");
raw.tests.T7.member_vote = sent.record;
raw.tests.T7.dao_proposal = await view(DAO, "get_proposal", { id: p7 });
raw.tests.T7.results = await view(VOTER, "get_results");
const restore = await call(signer(OWNER), WEIGHT, "add_weight", {
  dao: DAO, account: VOTER, amount: "1",
}, 100, "T7.restore_weight");
raw.tests.T7.restore_weight = restore.record;
raw.tests.T7.weight_after_restore = await view(DAO, "delegation_balance_of", { account_id: VOTER });
if (restore.record.error) throw new Error(`restore_weight failed: ${restore.record.error}`);

const accessBefore = await rpc("query", {
  request_type: "view_access_key_list",
  finality: "final",
  account_id: VOTER,
}, raw.rpc_calls);
const full = signer(VOTER);
const fullKey = accessBefore.result.keys.find((item) => item.access_key.permission === "FullAccess");
if (!fullKey || fullKey.public_key !== full.publicKey.toString()) throw new Error("expected voter FullAccess key not found");
const deleteResult = await send(full, VOTER, actionCreators.deleteKey(full.publicKey), "T8.delete_full_access_key", {
  method: "DeleteKey",
  public_key: full.publicKey.toString(),
});
const accessAfter = await rpc("query", {
  request_type: "view_access_key_list",
  finality: "final",
  account_id: VOTER,
}, raw.rpc_calls);
const agentKey = accessBefore.result.keys.find((item) =>
  item.access_key.permission?.FunctionCall?.method_names?.includes("submit_pending"));
raw.tests.T8 = {
  delete_full_access_key: deleteResult.record,
  access_keys_after: accessAfter.result.keys.map((item) => ({
    public_key: item.public_key,
    permission: item.access_key.permission,
    nonce: item.access_key.nonce,
  })),
  only_agent_key_remains: accessAfter.result.keys.length === 1
    && accessAfter.result.keys[0].public_key === agentKey?.public_key,
};

raw.views.final_controller = await view(VOTER, "get_controller");
raw.views.final_total_supply = await view(DAO, "delegation_total_supply");
raw.views.final_voter_weight = await view(DAO, "delegation_balance_of", { account_id: VOTER });
raw.views.final_voter_balance = await accountState(VOTER, "final", raw.rpc_calls);
raw.views.final_owner_balance = await accountState(OWNER, "final", raw.rpc_calls);
raw.views.final_dao_balance = await accountState(DAO, "final", raw.rpc_calls);
raw.views.final_weight_proxy_balance = await accountState(WEIGHT, "final", raw.rpc_calls);
raw.views.voter_storage_usage_bytes = raw.views.final_voter_balance.storage_usage;
raw.views.voter_storage_locked_yocto = String(BigInt(raw.views.voter_storage_usage_bytes) * 10n ** 19n);
raw.views.voter_storage_locked_near = (Number(raw.views.voter_storage_locked_yocto) / Number(YOCTO)).toString();
raw.metadata.finished_utc = new Date().toISOString();
saveRaw();
console.log(JSON.stringify({ completed: Object.keys(raw.tests), final_weight: raw.views.final_voter_weight, only_agent_key: raw.tests.T8.only_agent_key_remains }));
