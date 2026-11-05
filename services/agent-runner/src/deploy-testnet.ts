import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, type KeyPairString } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  GlobalContractDeployMode,
  type Action,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import { loadCredential } from "./rpc.js";

const TGAS = 1_000_000_000_000n;
const NEAR = 10n ** 24n;
const GLOBAL_STORAGE_COST_PER_BYTE = 100_000_000_000_000_000_000n;
const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));

function findRoot(start: string): string {
  let current = resolve(start);
  while (dirname(current) !== current) {
    if (existsSync(join(current, "Cargo.toml")) && existsSync(join(current, "contracts"))) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error("Could not locate Seats repository root");
}

interface DeployConfig {
  network: string;
  rpc_url: string;
  secrets_dir: string;
  funder_account_id: string;
  funder_key_file: string;
  verifier_account_id: string;
  verifier_key_file: string;
  dao_name: string;
  member_account_id: string;
  member_key_file: string;
  seat_account_id: string;
  seat_key_file: string;
  agent_key_file: string;
  quote_args_file: string;
  model: string;
  brief_hash: string;
  agent_wasm_url: string;
  agent_wasm_sha256: string;
  window_seconds: number;
}

type Credential = {
  accountId: string;
  signer: KeyPairSigner;
};

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function writeRecord(record: Record<string, unknown>): void {
  const file = resolve(ROOT, "deployments/testnet.json");
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
}

function keyPath(config: DeployConfig, file: string): string {
  return isAbsolute(file) ? file : resolve(config.secrets_dir, file);
}

function publicKeyFromFile(file: string): string {
  const content = readFileSync(file, "utf8");
  let key = content.trim();
  try {
    const parsed = JSON.parse(content) as { private_key?: string };
    if (parsed.private_key) key = parsed.private_key;
  } catch {
    // Accept raw key files as well as NEAR credential JSON.
  }
  return KeyPair.fromString(key as KeyPairString).getPublicKey().toString();
}

function assertTestnet(config: DeployConfig): void {
  const host = new URL(config.rpc_url).hostname.toLowerCase();
  if (config.network !== "testnet" || host.includes("mainnet") || !/(testnet|test\.|fastnear)/.test(host)) {
    throw new Error("Refusing deployment unless the configured RPC is testnet");
  }
  const secretsPath = resolve(config.secrets_dir);
  if (secretsPath === ROOT || secretsPath.startsWith(`${ROOT}/`)) {
    throw new Error("secrets_dir must be outside the repository");
  }
}

function recordTx(
  record: Record<string, unknown>,
  label: string,
  signer: string,
  receiver: string,
  hash: string,
): void {
  const transactions = (record.transactions as Record<string, string>[] | undefined) ?? [];
  transactions.push({ label, signer, receiver, hash });
  record.transactions = transactions;
  writeRecord(record);
}

async function main(args: string[]): Promise<void> {
  const configFlag = args.indexOf("--config");
  if (configFlag < 0 || !args[configFlag + 1]) {
    throw new Error("Usage: deploy-testnet.js --config /path/to/deploy-testnet.json");
  }
  const config = readJson(resolve(args[configFlag + 1])) as unknown as DeployConfig;
  assertTestnet(config);
  const provider = new JsonRpcProvider({ url: config.rpc_url }, { retries: 0 });
  const credentials: Record<string, Credential> = {};
  for (const [name, accountId, file] of [
    ["funder", config.funder_account_id, config.funder_key_file],
    ["verifier", config.verifier_account_id, config.verifier_key_file],
    ["member", config.member_account_id, config.member_key_file],
    ["seat", config.seat_account_id, config.seat_key_file],
  ]) {
    const loaded = loadCredential(keyPath(config, file), accountId);
    credentials[name] = { accountId, signer: loaded.signer };
  }
  const agentFile = keyPath(config, config.agent_key_file);
  const agentPublicKey = publicKeyFromFile(agentFile);
  const record = readJson(resolve(ROOT, "deployments/testnet.json"));
  const tx = async (
    credential: Credential,
    receiver: string,
    actions: Action[],
  ) => sendActions(provider, credential, receiver, actions);
  const call = async (
    credential: Credential,
    receiver: string,
    method: string,
    value: object,
    deposit = 0n,
    gas = 300n * TGAS,
  ) => tx(credential, receiver, [actionCreators.functionCall(method, value, gas, deposit)]);

  const verifierWasm = readFileSync(resolve(ROOT, "target/wasm32-unknown-unknown/release/tee_verifier.wasm"));
  const voterWasm = readFileSync(resolve(ROOT, "target/wasm32-unknown-unknown/release/seat_voter.wasm"));
  const seatWasm = readFileSync(resolve(ROOT, "target/wasm32-unknown-unknown/release/seat_nft.wasm"));
  const hashes = {
    tee_verifier: baseEncode(createHash("sha256").update(verifierWasm).digest()),
    seat_voter: baseEncode(createHash("sha256").update(voterWasm).digest()),
    seat_nft: baseEncode(createHash("sha256").update(seatWasm).digest()),
  };
  record.code_hashes = hashes;

  const verifierAccount = await provider.viewAccount(config.verifier_account_id);
  if (verifierAccount.code_hash !== hashes.tee_verifier) {
    const sent = await tx(credentials.verifier, config.verifier_account_id, [actionCreators.deployContract(verifierWasm)]);
    recordTx(record, "deploy_tee_verifier", credentials.verifier.accountId, config.verifier_account_id, sent.hash);
  }
  let verifierInitialized = false;
  try {
    verifierInitialized = Boolean(await callView(provider, config.verifier_account_id, "get_model_signer", {}));
  } catch {
    verifierInitialized = false;
  }
  if (!verifierInitialized) {
    const sent = await call(credentials.verifier, config.verifier_account_id, "new", {});
    recordTx(record, "init_tee_verifier", credentials.verifier.accountId, config.verifier_account_id, sent.hash);
  }
  const quote = readJson(keyPath(config, config.quote_args_file)) as {
    quote_hex: string;
    collateral_json: string;
    nonce: string;
    expected_signer: string;
  };
  if (!quote.expected_signer) throw new Error("Fresh quote args must include expected_signer");
  const registered = await call(credentials.verifier, config.verifier_account_id, "register_model_signer", {
    quote_hex: quote.quote_hex,
    collateral_json: quote.collateral_json,
    nonce: quote.nonce,
  });
  if (registered.value !== quote.expected_signer) throw new Error("Verifier signer did not match the fresh quote");
  recordTx(record, "register_model_signer", credentials.verifier.accountId, config.verifier_account_id, registered.hash);

  const previousGlobal = (record.seat_voter_global ?? record.prior_global_contract) as
    | { code_hash?: string }
    | undefined;
  if (previousGlobal?.code_hash !== hashes.seat_voter) {
    const sizeEstimate = BigInt(voterWasm.length) * GLOBAL_STORAGE_COST_PER_BYTE + NEAR;
    const funder = await provider.viewAccount(config.funder_account_id);
    if (BigInt(funder.amount) < sizeEstimate) {
      throw new Error(`Global voter deploy needs about ${formatNear(sizeEstimate)} NEAR; funder balance is ${formatNear(BigInt(funder.amount))} NEAR`);
    }
    const deployMode = new GlobalContractDeployMode({ CodeHash: null });
    const sent = await tx(credentials.funder, config.funder_account_id, [
      actionCreators.deployGlobalContract(voterWasm, deployMode),
    ]);
    recordTx(record, "deploy_seat_voter_global", credentials.funder.accountId, config.funder_account_id, sent.hash);
  }
  record.seat_voter_global = {
    code_hash: hashes.seat_voter,
    reused: previousGlobal?.code_hash === hashes.seat_voter,
    previous_code_hash: previousGlobal?.code_hash ?? null,
  };
  writeRecord(record);

  const daoId = `${config.dao_name}.sputnikv2.testnet`;
  const daoArgs = {
    config: { name: "Seats Testnet", purpose: "Transferable club memberships", metadata: "" },
    policy: daoPolicy(config.funder_account_id),
  };
  try {
    await callView(provider, daoId, "get_last_proposal_id", {});
  } catch {
    const created = await call(credentials.funder, "sputnikv2.testnet", "create", {
      name: config.dao_name,
      args: Buffer.from(JSON.stringify(daoArgs)).toString("base64"),
    }, 6n * NEAR);
    record.accounts = { ...((record.accounts as object | undefined) ?? {}), dao: daoId };
    recordTx(record, "create_dao", credentials.funder.accountId, "sputnikv2.testnet", created.hash);
  }
  const daoBalance = BigInt((await provider.viewAccount(daoId)).amount);
  const daoTarget = 55n * NEAR;
  if (daoBalance < daoTarget) {
    const funded = await tx(credentials.funder, daoId, [actionCreators.transfer(daoTarget - daoBalance)]);
    recordTx(record, "fund_dao_treasury", credentials.funder.accountId, daoId, funded.hash);
  }

  const seatAccount = await provider.viewAccount(config.seat_account_id);
  if (seatAccount.code_hash !== hashes.seat_nft) {
    const sent = await tx(credentials.seat, config.seat_account_id, [actionCreators.deployContract(seatWasm)]);
    recordTx(record, "deploy_seat_nft", credentials.seat.accountId, config.seat_account_id, sent.hash);
  }
  try {
    await callView(provider, config.seat_account_id, "get_dao", {});
  } catch {
    const sent = await call(credentials.seat, config.seat_account_id, "new", {
      dao: daoId,
      voter_code_hash: hashes.seat_voter,
      levy_bps: 500,
      window_ns: config.window_seconds * 1_000_000_000,
    });
    recordTx(record, "init_seat_nft", credentials.seat.accountId, config.seat_account_id, sent.hash);
  }
  let stakingContract: string | null = null;
  try {
    stakingContract = await callView<string | null>(provider, daoId, "get_staking_contract", {});
  } catch {
    stakingContract = null;
  }
  if (stakingContract !== config.seat_account_id) {
    const stakingKind = { SetStakingContract: { staking_id: config.seat_account_id } };
    await proposeAndApprove(provider, credentials.funder, daoId, stakingKind, "Set seat staking contract", record, call);
  }

  const mintKind = {
    FunctionCall: {
      receiver_id: config.seat_account_id,
      actions: [{
        method_name: "mint_seat",
        args: Buffer.from(JSON.stringify({
          receiver_id: config.member_account_id,
          agent_public_key: agentPublicKey,
        })).toString("base64"),
        deposit: String(50n * NEAR),
        gas: String(200n * TGAS),
      }],
    },
  };
  let seatView: { voter_id: string } | null = null;
  try {
    seatView = await callView<{ voter_id: string } | null>(
      provider,
      config.seat_account_id,
      "get_seat",
      { token_id: "1" },
    );
  } catch {
    seatView = null;
  }
  if (!seatView) {
    await proposeAndApprove(provider, credentials.funder, daoId, mintKind, "Mint first seat", record, call);
    seatView = await callView<{ voter_id: string }>(
      provider,
      config.seat_account_id,
      "get_seat",
      { token_id: "1" },
    );
  }
  const voterId = seatView?.voter_id;
  if (!voterId) throw new Error("Minted seat did not expose its voter account");
  record.accounts = { ...((record.accounts as object | undefined) ?? {}), dao: daoId, seat: config.seat_account_id, voter: voterId, verifier: config.verifier_account_id };
  writeRecord(record);

  await proposeAndApprove(provider, credentials.funder, daoId, functionCallKind(config.seat_account_id, "set_voter_model_signer", {
    token_id: "1",
    address_hex: quote.expected_signer,
    model: config.model,
  }), "Set model signer", record, call);
  await proposeAndApprove(provider, credentials.funder, daoId, functionCallKind(config.seat_account_id, "pin_voter_agent", {
    token_id: "1",
    url: config.agent_wasm_url,
    sha256: config.agent_wasm_sha256,
  }), "Pin agent job", record, call);
  const brief = await call(credentials.member, voterId, "set_brief_hash", { brief_hash: config.brief_hash });
  recordTx(record, "set_brief_hash", credentials.member.accountId, voterId, brief.hash);
  const votersFile = resolve(config.secrets_dir, "voters.json");
  writeFileSync(votersFile, `${JSON.stringify([{ voter_id: voterId, agent_key_file: agentFile }], null, 2)}\n`, { mode: 0o600 });
  record.runner_voters_file = votersFile;
  record.seat_voter_global = { ...record.seat_voter_global as object, account_id: voterId };
  record.status = "deployed";
  writeRecord(record);
}

function functionCallKind(receiver: string, method: string, args: object) {
  return {
    FunctionCall: {
      receiver_id: receiver,
      actions: [{
        method_name: method,
        args: Buffer.from(JSON.stringify(args)).toString("base64"),
        deposit: "0",
        gas: String(100n * TGAS),
      }],
    },
  };
}

async function proposeAndApprove(
  provider: JsonRpcProvider,
  funder: Credential,
  daoId: string,
  kind: object,
  description: string,
  record: Record<string, unknown>,
  call: (credential: Credential, receiver: string, method: string, args: object, deposit?: bigint, gas?: bigint) => Promise<{ hash: string; value: unknown }>,
): Promise<void> {
  const added = await call(funder, daoId, "add_proposal", { proposal: { description, kind } });
  recordTx(record, `add_${description.toLowerCase().replaceAll(" ", "_")}`, funder.accountId, daoId, added.hash);
  const last = Number(await callView(provider, daoId, "get_last_proposal_id", {}));
  const proposalId = last - 1;
  const approved = await call(funder, daoId, "act_proposal", {
    id: proposalId,
    action: "VoteApprove",
    proposal: kind,
    memo: null,
  });
  recordTx(record, `approve_${description.toLowerCase().replaceAll(" ", "_")}`, funder.accountId, daoId, approved.hash);
}

async function callView<T = unknown>(
  provider: JsonRpcProvider,
  account: string,
  method: string,
  args: object,
): Promise<T> {
  const response = await provider.sendJsonRpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(response.result).toString("utf8")) as T;
}

async function sendActions(
  provider: JsonRpcProvider,
  credential: Credential,
  receiver: string,
  actions: Action[],
): Promise<{ hash: string; value: unknown }> {
  const publicKey = await credential.signer.getPublicKey();
  const accessKey = await provider.viewAccessKey(credential.accountId, publicKey, { finality: "final" });
  const block = await provider.viewBlock({ finality: "optimistic" });
  const transaction = createTransaction(
    credential.accountId,
    publicKey,
    receiver,
    BigInt(accessKey.nonce) + 1n,
    actions,
    baseDecode(block.header.hash),
  );
  const [hashBytes, signed] = await credential.signer.signTransaction(transaction);
  const outcome = await provider.sendTransaction(signed);
  const result = outcome as unknown as {
    status?: { Failure?: unknown; SuccessValue?: string };
    transaction_outcome?: { outcome?: { status?: { Failure?: unknown } } };
    receipts_outcome?: Array<{ outcome?: { status?: { Failure?: unknown } } }>;
  };
  const failures = [
    result.status?.Failure,
    result.transaction_outcome?.outcome?.status?.Failure,
    ...(result.receipts_outcome ?? []).map((receipt) => receipt.outcome?.status?.Failure),
  ].filter(Boolean);
  if (failures.length) throw new Error(JSON.stringify(failures));
  const successValue = result.status?.SuccessValue;
  let value: unknown = null;
  if (successValue) {
    const decoded = Buffer.from(successValue, "base64").toString("utf8");
    try {
      value = JSON.parse(decoded);
    } catch {
      value = decoded;
    }
  }
  return { hash: baseEncode(hashBytes), value };
}

function daoPolicy(funder: string): object {
  const tokenPolicy = { weight_kind: "TokenWeight", quorum: "0", threshold: [1, 2] };
  return {
    roles: [
      { name: "council", kind: { Group: [funder] }, permissions: ["*:*"], vote_policy: {} },
      {
        name: "members",
        kind: { Member: "1" },
        permissions: ["transfer:AddProposal", "transfer:VoteApprove", "transfer:VoteReject", "call:AddProposal", "call:VoteApprove", "call:VoteReject"],
        vote_policy: { transfer: tokenPolicy, call: tokenPolicy },
      },
    ],
    default_vote_policy: tokenPolicy,
    proposal_bond: "0",
    proposal_period: "300000000000",
    bounty_bond: "0",
    bounty_forgiveness_period: "0",
  };
}

function formatNear(yocto: bigint): string {
  return (Number(yocto) / Number(NEAR)).toString();
}

export { main };
