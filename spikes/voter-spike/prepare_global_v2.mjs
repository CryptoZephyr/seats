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
  transactionError,
  viewContract,
} from "/home/ubuntu/near-spike/dao-latency/fc_key_common.mjs";

const OWNER = "zspike-1793094130.testnet";
const DAO = `dao.${OWNER}`;
const WEIGHT = `weight.${OWNER}`;
const RACE = `race.${OWNER}`;
const VOTER = "seatvoter-v2a-1793831906.testnet";
const RAW_PATH = "/home/ubuntu/near-research/voter-spike/raw-v2.json";
const SECRET_DIR = "/home/ubuntu/near-spike/secrets/seat-voter-spike-v2";
const YOCTO = 10n ** 24n;
const T_GAS = 10n ** 12n;
const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));
raw.transactions ??= [];
raw.dao_test ??= {};
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
  const total = (field) => items.reduce((sum, item) => sum + BigInt(item?.[field] ?? 0), 0n).toString();
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
  raw.rpc_calls = raw.rpc_calls.slice(-1000);
  saveJson(RAW_PATH, raw);
  if (record.error) throw new Error(`${label}: ${record.error}`);
  return { record, result };
}

const owner = loadCredential(OWNER);
const voter = loadV2Credential(VOTER, "voter-a.json");
const agent = loadV2Credential(VOTER, "voter-a-agent.json");
const allowance = YOCTO / 4n;
const agentKeyAction = actionCreators.addKey(
  agent.publicKey,
  actionCreators.functionCallAccessKey(VOTER, ["submit_pending"], allowance),
);
const addKeyResult = await send(
  voter,
  VOTER,
  agentKeyAction,
  "add_agent_submit_pending_key",
  "addKey",
  {
    receiver_id: VOTER,
    method_names: ["submit_pending"],
    allowance_yocto: String(allowance),
  },
  0n,
);
raw.dao_test.agent_access_key = {
  permission: "FunctionCall",
  receiver_id: VOTER,
  method_names: ["submit_pending"],
  allowance_yocto: String(allowance),
  tx_hash: addKeyResult.record.hash,
};

const registerArgs = { dao: DAO, account: VOTER };
await send(
  owner,
  WEIGHT,
  actionCreators.functionCall("register", registerArgs, 100n * T_GAS, 0n),
  "register_voter_weight",
  "register",
  registerArgs,
  100n * T_GAS,
);
const weightArgs = { dao: DAO, account: VOTER, amount: "1" };
await send(
  owner,
  WEIGHT,
  actionCreators.functionCall("add_weight", weightArgs, 100n * T_GAS, 0n),
  "add_voter_weight",
  "add_weight",
  weightArgs,
  100n * T_GAS,
);
raw.dao_test.weight = {
  voter_weight: (await viewContract(DAO, "delegation_balance_of", { account_id: VOTER }, "final")).value,
  total_supply: (await viewContract(DAO, "delegation_total_supply", {}, "final")).value,
  voter_account: await accountState(VOTER, "final", raw.rpc_calls),
  owner_account: await accountState(OWNER, "final", raw.rpc_calls),
};
if (BigInt(raw.dao_test.weight.voter_weight) !== 1n) throw new Error("voter weight is not 1");
if (BigInt(raw.dao_test.weight.owner_account.amount) < 300_000_000_000_000_000_000_000n) {
  throw new Error("owner balance fell below 0.3 NEAR");
}

const before = Number((await viewContract(DAO, "get_last_proposal_id", {}, "final")).value);
const actions = (await viewContract(RACE, "get_actions", {}, "final")).value;
const used = new Set(actions.map((item) => Number(item.leg)));
const leg = Array.from({ length: 1000 }, (_, index) => 1000 + index).find((item) => !used.has(item));
if (leg == null) throw new Error("unable to find an unused race leg");
const proposal = {
  description: "voter-spike-v2: NEAR AI receipt verification",
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
const proposalArgs = { proposal };
const created = await send(
  owner,
  DAO,
  actionCreators.functionCall("add_proposal", proposalArgs, 60n * T_GAS, 0n),
  "create_fresh_receipt_proposal",
  "add_proposal",
  proposalArgs,
  60n * T_GAS,
);
const proposalId = parseProposalId(created.result)
  ?? Number((await viewContract(DAO, "get_last_proposal_id", {}, "final")).value);
if (!Number.isSafeInteger(proposalId) || proposalId < before) {
  throw new Error("fresh proposal ID did not advance");
}
raw.dao_test.proposal = {
  proposal_id: proposalId,
  next_id_before: before,
  race_leg: leg,
  proposal,
  created_tx_hash: created.record.hash,
  created_tx_utc: created.record.block_timestamp_utc,
  status: (await viewContract(DAO, "get_proposal", { id: proposalId }, "final")).value,
};
saveJson(RAW_PATH, raw);
console.log(JSON.stringify({
  voter: VOTER,
  agent_key_tx: addKeyResult.record.hash,
  voter_weight: raw.dao_test.weight.voter_weight,
  owner_balance: raw.dao_test.weight.owner_account.amount,
  proposal_id: proposalId,
  proposal_tx: created.record.hash,
  race_leg: leg,
}));
