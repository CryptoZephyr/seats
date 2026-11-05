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
import { sendWithNonceRetry } from "./nonce.js";
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
  brief_secrets_account_id: string;
  brief_secrets_profile: string;
  agent_wasm_url: string;
  agent_wasm_sha256: string;
  window_seconds: number;
  voter_funding_near?: number;
  dao_funding_near?: number;
}

type Credential = {
  accountId: string;
  signer: KeyPairSigner;
};

type DeployCall = (
  credential: Credential,
  receiver: string,
  method: string,
  value: object,
  deposit?: bigint,
  gas?: bigint,
) => Promise<{ hash: string; value: unknown }>;

export interface DeployTestDependencies {
  provider?: JsonRpcProvider;
  artifactRoot?: string;
  recordPath?: string;
  loadCredential?: typeof loadCredential;
  publicKeyFromFile?: typeof publicKeyFromFile;
  sendActions?: typeof sendActions;
  call?: DeployCall;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function writeRecord(
  record: Record<string, unknown>,
  file = resolve(ROOT, "deployments/testnet.json"),
): void {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function isUninitializedContractError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const details = current as { message?: unknown; cause?: unknown };
    if (
      typeof details.message === "string" &&
      /Contract must be initialized before usage|ERR_NOT_INITIALIZED|contract[^\n]*(?:not initialized|uninitialized)|(?:cannot|failed to|unable to) deserialize[^\n]*contract/i.test(details.message)
    ) {
      return true;
    }
    current = details.cause;
  }
  return typeof error === "string" &&
    /Contract must be initialized before usage|ERR_NOT_INITIALIZED|contract[^\n]*(?:not initialized|uninitialized)|(?:cannot|failed to|unable to) deserialize[^\n]*contract/i.test(error);
}

export function isMissingAccountError(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const details = current as { type?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (
      [details.type, details.name].some(
        (value) => typeof value === "string" && value.toUpperCase() === "UNKNOWN_ACCOUNT",
      )
    ) {
      return true;
    }
    if (
      typeof details.message === "string" &&
      /account[^\n]*(?:doesn't exist|does not exist|not found)/i.test(details.message)
    ) {
      return true;
    }
    current = details.cause;
  }
  return typeof error === "string" &&
    /account[^\n]*(?:doesn't exist|does not exist|not found)/i.test(error);
}

function isVoterConfig(value: unknown): value is { voter_id: string; agent_key_file: string } {
  return typeof value === "object" &&
    value !== null &&
    "voter_id" in value &&
    typeof value.voter_id === "string" &&
    "agent_key_file" in value &&
    typeof value.agent_key_file === "string";
}

function recordTx(
  record: Record<string, unknown>,
  label: string,
  signer: string,
  receiver: string,
  hash: string,
  persistRecord: (record: Record<string, unknown>) => void = writeRecord,
): void {
  const transactions = (record.transactions as Record<string, string>[] | undefined) ?? [];
  transactions.push({ label, signer, receiver, hash });
  record.transactions = transactions;
  persistRecord(record);
}

export async function main(
  args: string[],
  dependencies: DeployTestDependencies = {},
): Promise<void> {
  const configFlag = args.indexOf("--config");
  if (configFlag < 0 || !args[configFlag + 1]) {
    throw new Error("Usage: deploy-testnet.js --config /path/to/deploy-testnet.json");
  }
  const config = readJson(resolve(args[configFlag + 1])) as unknown as DeployConfig;
  const voterFundingNear = config.voter_funding_near ?? 5;
  const daoFundingNear = config.dao_funding_near ?? voterFundingNear + 3;
  assertTestnet(config);
  const artifactRoot = resolve(dependencies.artifactRoot ?? ROOT);
  const recordPath = dependencies.recordPath ?? resolve(artifactRoot, "deployments/testnet.json");
  const provider = dependencies.provider ?? new JsonRpcProvider({ url: config.rpc_url }, { retries: 0 });
  const credentialLoader = dependencies.loadCredential ?? loadCredential;
  const credentials: Record<string, Credential> = {};
  for (const [name, accountId, file] of [
    ["funder", config.funder_account_id, config.funder_key_file],
    ["verifier", config.verifier_account_id, config.verifier_key_file],
    ["member", config.member_account_id, config.member_key_file],
    ["seat", config.seat_account_id, config.seat_key_file],
  ]) {
    const loaded = credentialLoader(keyPath(config, file), accountId);
    credentials[name] = { accountId, signer: loaded.signer };
  }
  const agentFile = keyPath(config, config.agent_key_file);
  const agentPublicKey = (dependencies.publicKeyFromFile ?? publicKeyFromFile)(agentFile);
  const record = readJson(recordPath);
  const persistRecord = (nextRecord: Record<string, unknown>) => writeRecord(nextRecord, recordPath);
  const nonceCache = new Map<string, bigint>();
  const send = dependencies.sendActions ?? sendActions;
  const tx = async (
    credential: Credential,
    receiver: string,
    actions: Action[],
  ) => send(provider, credential, receiver, actions, nonceCache);
  const call: DeployCall = dependencies.call ?? (async (
    credential: Credential,
    receiver: string,
    method: string,
    value: object,
    deposit = 0n,
    gas = 300n * TGAS,
  ) => tx(credential, receiver, [actionCreators.functionCall(method, value, gas, deposit)]));

  const verifierWasm = readFileSync(resolve(artifactRoot, "target/wasm32-unknown-unknown/release/tee_verifier.wasm"));
  const voterWasm = readFileSync(resolve(artifactRoot, "target/wasm32-unknown-unknown/release/seat_voter.wasm"));
  const seatWasm = readFileSync(resolve(artifactRoot, "target/wasm32-unknown-unknown/release/seat_nft.wasm"));
  const hashes = {
    tee_verifier: baseEncode(createHash("sha256").update(verifierWasm).digest()),
    seat_voter: baseEncode(createHash("sha256").update(voterWasm).digest()),
    seat_nft: baseEncode(createHash("sha256").update(seatWasm).digest()),
  };
  record.code_hashes = hashes;

  const verifierAccount = await provider.viewAccount(config.verifier_account_id, { finality: "optimistic" });
  if (verifierAccount.code_hash !== hashes.tee_verifier) {
    const sent = await tx(credentials.verifier, config.verifier_account_id, [actionCreators.deployContract(verifierWasm)]);
    recordTx(record, "deploy_tee_verifier", credentials.verifier.accountId, config.verifier_account_id, sent.hash, persistRecord);
  }
  let verifierSigner: string | null = null;
  let verifierInitialized = false;
  try {
    verifierSigner = await callView<string>(
      provider,
      config.verifier_account_id,
      "get_model_signer",
      {},
      "optimistic",
    );
    verifierInitialized = true;
  } catch (error) {
    if (!isUninitializedContractError(error)) {
      throw new Error(`Could not confirm verifier initialization: ${errorMessage(error)}`, { cause: error });
    }
  }
  if (!verifierInitialized) {
    const sent = await call(credentials.verifier, config.verifier_account_id, "new", {});
    recordTx(record, "init_tee_verifier", credentials.verifier.accountId, config.verifier_account_id, sent.hash, persistRecord);
  }
  const quote = readJson(keyPath(config, config.quote_args_file)) as {
    quote_hex: string;
    collateral_json: string;
    nonce: string;
    expected_signer: string;
  };
  if (!quote.expected_signer) throw new Error("Fresh quote args must include expected_signer");
  if (verifierSigner?.toLowerCase() !== quote.expected_signer.toLowerCase()) {
    const registered = await call(credentials.verifier, config.verifier_account_id, "register_model_signer", {
      quote_hex: quote.quote_hex,
      collateral_json: quote.collateral_json,
      nonce: quote.nonce,
    });
    if (registered.value !== quote.expected_signer) throw new Error("Verifier signer did not match the fresh quote");
    recordTx(record, "register_model_signer", credentials.verifier.accountId, config.verifier_account_id, registered.hash, persistRecord);
  }

  const recordedGlobal = record.seat_voter_global as { code_hash?: string; [key: string]: unknown } | undefined;
  const priorGlobal = record.prior_global_contract as { code_hash?: string } | undefined;
  const previousGlobalHash = recordedGlobal?.code_hash ?? priorGlobal?.code_hash;
  const globalAlreadyDeployed = previousGlobalHash === hashes.seat_voter;
  const globalRecord = {
    ...recordedGlobal,
    code_hash: hashes.seat_voter,
    reused: globalAlreadyDeployed,
    previous_code_hash: previousGlobalHash ?? null,
  };
  if (!globalAlreadyDeployed) {
    const sizeEstimate = BigInt(voterWasm.length) * GLOBAL_STORAGE_COST_PER_BYTE + NEAR;
    const funder = await provider.viewAccount(config.funder_account_id, { finality: "optimistic" });
    if (BigInt(funder.amount) < sizeEstimate) {
      throw new Error(`Global voter deploy needs about ${formatNear(sizeEstimate)} NEAR; funder balance is ${formatNear(BigInt(funder.amount))} NEAR`);
    }
    const deployMode = new GlobalContractDeployMode({ CodeHash: null });
    const sent = await tx(credentials.funder, config.funder_account_id, [
      actionCreators.deployGlobalContract(voterWasm, deployMode),
    ]);
    record.seat_voter_global = globalRecord;
    recordTx(record, "deploy_seat_voter_global", credentials.funder.accountId, config.funder_account_id, sent.hash, persistRecord);
  } else {
    record.seat_voter_global = globalRecord;
    persistRecord(record);
  }

  const daoId = `${config.dao_name}.sputnikv2.testnet`;
  const daoArgs = {
    config: { name: "Seats Testnet", purpose: "Transferable club memberships", metadata: "" },
    policy: daoPolicy(config.funder_account_id),
  };
  let daoExists = true;
  try {
    await provider.viewAccount(daoId, { finality: "optimistic" });
  } catch (error) {
    if (!isMissingAccountError(error)) {
      throw new Error(`Could not confirm DAO account ${daoId}: ${errorMessage(error)}`, { cause: error });
    }
    daoExists = false;
  }
  if (daoExists) {
    await callView(provider, daoId, "get_last_proposal_id", {});
  } else {
    const created = await call(credentials.funder, "sputnikv2.testnet", "create", {
      name: config.dao_name,
      args: Buffer.from(JSON.stringify(daoArgs)).toString("base64"),
    }, 6n * NEAR);
    record.accounts = { ...((record.accounts as object | undefined) ?? {}), dao: daoId };
    recordTx(record, "create_dao", credentials.funder.accountId, "sputnikv2.testnet", created.hash, persistRecord);
  }
  const daoBalance = BigInt((await provider.viewAccount(daoId, { finality: "optimistic" })).amount);
  const daoTarget = BigInt(daoFundingNear) * NEAR;
  if (daoBalance < daoTarget) {
    const funded = await tx(credentials.funder, daoId, [actionCreators.transfer(daoTarget - daoBalance)]);
    recordTx(record, "fund_dao_treasury", credentials.funder.accountId, daoId, funded.hash, persistRecord);
  }

  const seatAccount = await provider.viewAccount(config.seat_account_id, { finality: "optimistic" });
  if (seatAccount.code_hash !== hashes.seat_nft) {
    const sent = await tx(credentials.seat, config.seat_account_id, [actionCreators.deployContract(seatWasm)]);
    recordTx(record, "deploy_seat_nft", credentials.seat.accountId, config.seat_account_id, sent.hash, persistRecord);
  }
  let seatView: { voter_id: string } | null = null;
  try {
    seatView = await callView<{ voter_id: string } | null>(
      provider,
      config.seat_account_id,
      "get_seat",
      { token_id: "1" },
    );
  } catch (error) {
    if (!isUninitializedContractError(error)) {
      throw new Error(`Could not confirm seat contract initialization: ${errorMessage(error)}`, { cause: error });
    }
    const sent = await call(credentials.seat, config.seat_account_id, "new", {
      dao: daoId,
      voter_code_hash: hashes.seat_voter,
      levy_bps: 500,
      window_ns: config.window_seconds * 1_000_000_000,
    });
    recordTx(record, "init_seat_nft", credentials.seat.accountId, config.seat_account_id, sent.hash, persistRecord);
  }
  let stakingContract: string | null = null;
  stakingContract = await callView<string | null>(provider, daoId, "get_staking_contract", {});
  if (stakingContract !== config.seat_account_id) {
    const stakingKind = { SetStakingContract: { staking_id: config.seat_account_id } };
    await proposeAndApprove(provider, credentials.funder, daoId, stakingKind, "Set seat staking contract", record, call, undefined, persistRecord);
  }

  const voterFunding = BigInt(voterFundingNear) * NEAR;
  const mintKind = {
    FunctionCall: {
      receiver_id: config.seat_account_id,
      actions: [{
        method_name: "mint_seat",
        args: Buffer.from(JSON.stringify({
          receiver_id: config.member_account_id,
          agent_public_key: agentPublicKey,
        })).toString("base64"),
        deposit: String(voterFunding),
        gas: String(200n * TGAS),
      }],
    },
  };
  if (!seatView) {
    const approvedMint = await findProposalIdByStatus(provider, daoId, mintKind, "Approved");
    if (approvedMint !== null) {
      throw new Error(`Mint proposal ${approvedMint} is approved but seat 1 is not visible, refusing to submit another mint`);
    }
    await proposeAndApprove(provider, credentials.funder, daoId, mintKind, "Mint first seat", record, call, undefined, persistRecord);
    seatView = await callView<{ voter_id: string }>(
      provider,
      config.seat_account_id,
      "get_seat",
      { token_id: "1" },
      "optimistic",
    );
  }
  const voterId = seatView?.voter_id;
  if (!voterId) throw new Error("Minted seat did not expose its voter account");
  record.accounts = { ...((record.accounts as object | undefined) ?? {}), dao: daoId, seat: config.seat_account_id, voter: voterId, verifier: config.verifier_account_id };
  persistRecord(record);

  let priorAgentConfig = record.agent_configuration as {
    voter_id?: string;
    model_signer?: { address_hex?: string; model?: string };
    pinned_agent?: { url?: string; sha256?: string };
  } | undefined;
  if (
    priorAgentConfig?.voter_id !== voterId ||
    priorAgentConfig?.model_signer?.address_hex !== quote.expected_signer ||
    priorAgentConfig?.model_signer?.model !== config.model
  ) {
    const nextAgentConfig = {
      ...priorAgentConfig,
      voter_id: voterId,
      model_signer: { address_hex: quote.expected_signer, model: config.model },
    };
    const kind = functionCallKind(config.seat_account_id, "set_voter_model_signer", {
      token_id: "1",
      address_hex: quote.expected_signer,
      model: config.model,
    });
    await assertNoUnrecordedApproval(provider, daoId, kind, "model signer");
    await proposeAndApprove(
      provider,
      credentials.funder,
      daoId,
      kind,
      "Set model signer",
      record,
      call,
      () => {
        priorAgentConfig = nextAgentConfig;
        record.agent_configuration = nextAgentConfig;
      },
      persistRecord,
    );
  }
  if (
    priorAgentConfig?.voter_id !== voterId ||
    priorAgentConfig?.pinned_agent?.url !== config.agent_wasm_url ||
    priorAgentConfig?.pinned_agent?.sha256 !== config.agent_wasm_sha256
  ) {
    const nextAgentConfig = {
      ...priorAgentConfig,
      voter_id: voterId,
      pinned_agent: { url: config.agent_wasm_url, sha256: config.agent_wasm_sha256 },
    };
    const kind = functionCallKind(config.seat_account_id, "pin_voter_agent", {
      token_id: "1",
      url: config.agent_wasm_url,
      sha256: config.agent_wasm_sha256,
    });
    await assertNoUnrecordedApproval(provider, daoId, kind, "agent WASM pin");
    await proposeAndApprove(
      provider,
      credentials.funder,
      daoId,
      kind,
      "Pin agent job",
      record,
      call,
      () => {
        priorAgentConfig = nextAgentConfig;
        record.agent_configuration = nextAgentConfig;
      },
      persistRecord,
    );
  }
  const currentBrief = await callView<{
    brief_hash: string;
    secrets_account_id: string | null;
    secrets_profile: string | null;
  }>(provider, voterId, "get_brief", {}, "optimistic");
  if (
    currentBrief.brief_hash !== config.brief_hash ||
    currentBrief.secrets_account_id !== config.brief_secrets_account_id ||
    currentBrief.secrets_profile !== config.brief_secrets_profile
  ) {
    const brief = await call(credentials.member, voterId, "set_brief", {
      brief_hash: config.brief_hash,
      secrets_account_id: config.brief_secrets_account_id,
      secrets_profile: config.brief_secrets_profile,
    });
    recordTx(record, "set_brief", credentials.member.accountId, voterId, brief.hash, persistRecord);
  }
  const votersFile = resolve(config.secrets_dir, "voters.json");
  const existingVoters = existsSync(votersFile)
    ? JSON.parse(readFileSync(votersFile, "utf8")) as unknown
    : [];
  if (!Array.isArray(existingVoters) || !existingVoters.every(isVoterConfig)) {
    throw new Error(`Invalid voters file at ${votersFile}`);
  }
  const voters = existingVoters.filter((voter) => voter.voter_id !== voterId);
  voters.push({ voter_id: voterId, agent_key_file: agentFile });
  writeFileSync(votersFile, `${JSON.stringify(voters, null, 2)}\n`, { mode: 0o600 });
  record.runner_voters_file = votersFile;
  record.seat_voter_global = { ...record.seat_voter_global as object, account_id: voterId };
  record.status = "deployed";
  persistRecord(record);
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
  afterApproval?: () => void,
  persistRecord: (record: Record<string, unknown>) => void = writeRecord,
): Promise<void> {
  let proposalId = await findPendingProposalId(provider, daoId, kind);
  if (proposalId === null) {
    const added = await call(funder, daoId, "add_proposal", { proposal: { description, kind } });
    recordTx(record, `add_${description.toLowerCase().replaceAll(" ", "_")}`, funder.accountId, daoId, added.hash, persistRecord);
    proposalId = parseProposalId(added.value);
  }
  const approved = await call(funder, daoId, "act_proposal", {
    id: proposalId,
    action: "VoteApprove",
    proposal: kind,
    memo: null,
  });
  afterApproval?.();
  recordTx(record, `approve_${description.toLowerCase().replaceAll(" ", "_")}`, funder.accountId, daoId, approved.hash, persistRecord);
}

export function parseProposalId(value: unknown): number {
  const proposalId = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(proposalId) || proposalId < 0) {
    throw new Error("Sputnik add_proposal did not return a non-negative integer proposal ID");
  }
  return proposalId;
}

type ProposalView = {
  id: number | string;
  kind: unknown;
  status: string;
};

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

async function findProposalIdByStatus(
  provider: JsonRpcProvider,
  daoId: string,
  kind: object,
  status: string,
): Promise<number | null> {
  const nextProposalId = Number(await callView<number | string>(provider, daoId, "get_last_proposal_id", {}));
  if (!Number.isSafeInteger(nextProposalId) || nextProposalId < 0) {
    throw new Error("DAO returned an invalid get_last_proposal_id value");
  }

  let match: number | null = null;
  const pageSize = 50;
  for (let fromIndex = 0; fromIndex < nextProposalId; fromIndex += pageSize) {
    const limit = Math.min(pageSize, nextProposalId - fromIndex);
    const proposals = await callView<ProposalView[]>(provider, daoId, "get_proposals", {
      from_index: fromIndex,
      limit,
    });
    for (const proposal of proposals) {
      if (proposal.status === status && sameJsonValue(proposal.kind, kind)) {
        match = parseProposalId(proposal.id);
      }
    }
  }
  return match;
}

export async function findPendingProposalId(
  provider: JsonRpcProvider,
  daoId: string,
  kind: object,
): Promise<number | null> {
  return findProposalIdByStatus(provider, daoId, kind, "InProgress");
}

async function assertNoUnrecordedApproval(
  provider: JsonRpcProvider,
  daoId: string,
  kind: object,
  description: string,
): Promise<void> {
  const proposalId = await findProposalIdByStatus(provider, daoId, kind, "Approved");
  if (proposalId !== null) {
    throw new Error(
      `Proposal ${proposalId} for ${description} is approved, but the deployment record cannot confirm its applied state`,
    );
  }
}

export async function callView<T = unknown>(
  provider: JsonRpcProvider,
  account: string,
  method: string,
  args: object,
  finality: "final" | "optimistic" = "optimistic",
): Promise<T> {
  const response = await provider.sendJsonRpc<{
    result?: number[];
    error?: unknown;
    error_message?: unknown;
    error_type?: unknown;
  }>("query", {
    request_type: "call_function",
    finality,
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (!Array.isArray(response?.result) || response.result.length === 0) {
    if (response?.error !== undefined) throw response.error;
    if (typeof response?.error_message === "string") throw new Error(response.error_message);
    if (typeof response?.error_type === "string") throw new Error(response.error_type);
    throw new Error(`View ${method} returned no result bytes`);
  }
  return JSON.parse(Buffer.from(response.result).toString("utf8")) as T;
}

async function sendActions(
  provider: JsonRpcProvider,
  credential: Credential,
  receiver: string,
  actions: Action[],
  nonceCache: Map<string, bigint>,
): Promise<{ hash: string; value: unknown }> {
  const publicKey = await credential.signer.getPublicKey();
  return sendWithNonceRetry(provider, credential.accountId, publicKey, nonceCache, async (nonce) => {
    const block = await provider.viewBlock({ finality: "optimistic" });
    const transaction = createTransaction(
      credential.accountId,
      publicKey,
      receiver,
      nonce,
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
  });
}

export function daoPolicy(funder: string): object {
  const tokenPolicy = { weight_kind: "TokenWeight", quorum: "0", threshold: [1, 2] };
  const councilPolicy = {
    weight_kind: "RoleWeight",
    quorum: "0",
    threshold: [1, 2],
  };
  const councilLabels = [
    "config",
    "policy",
    "add_member_to_role",
    "remove_member_from_role",
    "call",
    "upgrade_self",
    "upgrade_remote",
    "set_vote_token",
    "add_bounty",
    "bounty_done",
    "vote",
    "factory_info_update",
    "policy_add_or_update_role",
    "policy_remove_role",
    "policy_update_default_vote_policy",
    "policy_update_parameters",
  ];
  return {
    roles: [
      {
        name: "council",
        kind: { Group: [funder] },
        permissions: ["*:*"],
        vote_policy: Object.fromEntries(councilLabels.map((label) => [label, councilPolicy])),
      },
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
