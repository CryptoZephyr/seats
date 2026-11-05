import fs from "node:fs";
import { KeyPair } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/crypto/lib/esm/index.js";
import { KeyPairSigner } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/signers/lib/esm/key_pair_signer.js";
import { actionCreators } from "/home/ubuntu/near-spike/dao-latency/node_modules/@near-js/transactions/lib/esm/index.js";
import {
  accessKeyState,
  accountState,
  prepareTransaction,
  rpc,
  sendPrepared,
  transactionError,
  redactError,
} from "/home/ubuntu/near-spike/dao-latency/fc_key_common.mjs";

const RAW_PATH = "/home/ubuntu/near-research/voter-spike/raw-v2.json";
const SECRETS = "/home/ubuntu/near-spike/secrets/seat-voter-spike-v2";
const DEPLOYER_ID = "global-seat-1793831906.testnet";
const OWNER_ID = "zspike-1793094130.testnet";
const YOCTO = 10n ** 24n;
const raw = JSON.parse(fs.readFileSync(RAW_PATH, "utf8"));

if (!raw.global_deploy.funding_transfer_first_attempt) {
  const failedAttempt = {
    label: "faucet_voter_a_to_global_deployer_11_near",
    included: false,
    amount_near: "11",
    error_exact: "Sender seatvoter-v2a-1793831906.testnet does not have enough balance 10 for operation costing 11.00024550081875",
    retry_reason: "The non-included attempt was reduced to 9.5 NEAR, then 1.1 NEAR was sent from the second faucet account.",
  };
  raw.global_deploy.funding_transfer_first_attempt = failedAttempt;
  raw.transactions.push(failedAttempt);
}

const callLog = [];

function saveRaw() {
  fs.writeFileSync(RAW_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(RAW_PATH, 0o600);
}

async function transfer(funderId, keyFile, amountNear, label) {
  if (raw.transactions.some((item) => item.label === label)) {
    throw new Error(`refusing to repeat ${label}`);
  }
  const credential = JSON.parse(fs.readFileSync(`${SECRETS}/${keyFile}`, "utf8"));
  const pair = KeyPair.fromString(credential.private_key);
  const account = {
    accountId: funderId,
    publicKey: pair.getPublicKey(),
    signer: KeyPairSigner.fromSecretKey(credential.private_key),
    nonce: null,
  };
  const amount = BigInt(amountNear) * YOCTO;
  const [funderBefore, deployerBefore, ownerBefore] = await Promise.all([
    accountState(funderId, "final", callLog),
    accountState(DEPLOYER_ID, "final", callLog),
    accountState(OWNER_ID, "final", callLog),
  ]);
  const key = await accessKeyState(funderId, account.publicKey.toString(), "final", callLog);
  account.nonce = BigInt(key.nonce);
  const prepared = await prepareTransaction(
    account,
    DEPLOYER_ID,
    actionCreators.transfer(amount),
    callLog,
  );
  let sent;
  try {
    sent = await sendPrepared(prepared, callLog);
  } catch (error) {
    const rejected = {
      label,
      attempted_hash: prepared.hash,
      included: false,
      signer_id: funderId,
      receiver_id: DEPLOYER_ID,
      amount_yocto: String(amount),
      nonce_final_view: key.nonce,
      nonce_used: String(account.nonce),
      status: "RejectedBeforeInclusion",
      error: redactError(error),
      rpc_calls: callLog,
    };
    raw.transactions.push(rejected);
    saveRaw();
    throw error;
  }
  await sent.blockPromise;
  const finalized = await rpc("tx", {
    tx_hash: prepared.hash,
    sender_account_id: funderId,
    wait_until: "FINAL",
  }, callLog);
  const result = finalized.result;
  const outcomes = [
    result?.transaction_outcome?.outcome,
    ...(result?.receipts_outcome ?? []).map((item) => item.outcome),
  ].filter(Boolean);
  const sum = (field) => outcomes.reduce((total, item) => total + BigInt(item[field] ?? 0), 0n);
  const [funderAfter, deployerAfter, ownerAfter] = await Promise.all([
    accountState(funderId, "final", callLog),
    accountState(DEPLOYER_ID, "final", callLog),
    accountState(OWNER_ID, "final", callLog),
  ]);
  const record = {
    label,
    hash: prepared.hash,
    explorer: `https://explorer.testnet.near.org/transactions/${prepared.hash}`,
    signer_id: funderId,
    receiver_id: DEPLOYER_ID,
    amount_yocto: String(amount),
    nonce_final_view: key.nonce,
    nonce_used: String(account.nonce),
    block_hash: result?.transaction_outcome?.block_hash ?? null,
    block_height: result?.transaction_outcome?.outcome?.block_height ?? null,
    final_execution_status: result?.final_execution_status ?? null,
    status: result?.status ?? null,
    error: transactionError(result),
    gas_burnt_total: String(sum("gas_burnt")),
    tokens_burnt_total: String(sum("tokens_burnt")),
    transaction_outcome: result?.transaction_outcome ?? null,
    receipts_outcome: result?.receipts_outcome ?? [],
    balances_before: {
      funder: funderBefore.amount,
      deployer: deployerBefore.amount,
      owner: ownerBefore.amount,
    },
    balances_after: {
      funder: funderAfter.amount,
      deployer: deployerAfter.amount,
      owner: ownerAfter.amount,
    },
    rpc_calls: callLog,
  };
  raw.transactions.push(record);
  raw.global_deploy.funding_transfers ??= [];
  raw.global_deploy.funding_transfers.push(record);
  raw.provisioning.final_balances_after_topup ??= {};
  raw.provisioning.final_balances_after_topup[funderId] = funderAfter.amount;
  raw.provisioning.final_balances_after_topup[DEPLOYER_ID] = deployerAfter.amount;
  raw.provisioning.final_balances_after_topup[OWNER_ID] = ownerAfter.amount;
  saveRaw();
  console.log(JSON.stringify({
    label,
    hash: prepared.hash,
    final_execution_status: record.final_execution_status,
    error: redactError(record.error ?? ""),
    gas_burnt: record.gas_burnt_total,
    tokens_burnt: record.tokens_burnt_total,
    balances_after: record.balances_after,
  }));
  if (record.error) throw new Error(record.error);
}

await transfer(
  "seatvoter-v2a-1793831906.testnet",
  "voter-a.json",
  "9",
  "faucet_voter_a_to_global_deployer_9_near",
);
await transfer(
  "seatvoter-v2b-1793831906.testnet",
  "voter-b.json",
  "2",
  "faucet_voter_b_to_global_deployer_2_near",
);
