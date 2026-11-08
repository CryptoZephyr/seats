import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import {
  actionCreators,
  createTransaction,
  type Action,
} from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import {
  callView,
  isMissingAccountError,
  parseProposalId,
} from "./deploy-testnet.js";
import { loadCredential } from "./rpc.js";

const TGAS = 1_000_000_000_000n;
const PROPOSAL_BOND = 100_000_000_000_000_000_000_000n;
const VISITOR_FUNDING = 2n * 10n ** 23n;
const VISITOR_CLAIM_DEPOSIT = 5n * 10n ** 22n;
const VISITOR_GAS_RESERVE = 5n * 10n ** 22n;
const VISITOR_MINIMUM_BALANCE = PROPOSAL_BOND + VISITOR_CLAIM_DEPOSIT + VISITOR_GAS_RESERVE;
const CLAIM_SEAT_GAS = 300n * TGAS;
const APPLICATION_DURATION_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
const APPLICATION_PROPOSAL_ACTION_GAS = 10n * TGAS;
const COUNCIL_GOVERNANCE_LABELS = [
  "config",
  "policy",
  "add_member_to_role",
  "remove_member_from_role",
  "upgrade_self",
  "upgrade_remote",
  "set_vote_token",
  "factory_info_update",
  "policy_add_or_update_role",
  "policy_remove_role",
  "policy_update_default_vote_policy",
  "policy_update_parameters",
] as const;
const ROOT = findRoot(dirname(fileURLToPath(import.meta.url)));

interface Stage3Config {
  network: string;
  rpc_url: string;
  dao_id: string;
  seat_nft_id: string;
  voter_id: string;
  proposer_account_id: string;
  proposer_key_file: string;
  funder_account_id: string;
  funder_key_file: string;
  visitor_account_id: string;
  visitor_key_file?: string;
  runner_agent_key_file: string;
}

interface DeploymentAgentConfiguration {
  voter_id: string;
  model_signer_hex: string;
  model: string;
  agent_wasm_url: string;
  agent_wasm_sha256: string;
}

type VoterDefaults = Omit<DeploymentAgentConfiguration, "voter_id">;

type Credential = {
  accountId: string;
  signer: KeyPairSigner;
};

type ProposalView = {
  id: number | string;
  kind: unknown;
  status: string;
};

type Policy = {
  proposal_bond: string | number;
  roles: Array<{
    name: string;
    kind: unknown;
    permissions: string[];
    vote_policy: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

type ProposalStatus = {
  id: number;
  status: string;
};

type TransactionResult = {
  hash: string;
  value: unknown;
};

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

function defaultRunnerKeyPath(): string {
  return join(homedir(), "near-spike", "secrets", "runner-agent.json");
}

function assertExternalFile(path: string): string {
  const absolutePath = resolve(path);
  if (absolutePath === ROOT || absolutePath.startsWith(`${ROOT}/`)) {
    throw new Error("Key files must be stored outside the repository");
  }
  return absolutePath;
}

function writeKeyFile(path: string, accountId?: string): string {
  const absolutePath = assertExternalFile(path);
  mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
  if (existsSync(absolutePath)) {
    return loadCredential(absolutePath, accountId ?? "runner-agent.testnet", false)
      .publicKey.toString();
  }

  const keyPair = KeyPair.fromRandom("ed25519");
  const keyFile = {
    ...(accountId ? { account_id: accountId } : {}),
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
  };
  try {
    writeFileSync(absolutePath, `${JSON.stringify(keyFile, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return loadCredential(absolutePath, accountId ?? "runner-agent.testnet", false)
      .publicKey.toString();
  }
  return keyFile.public_key;
}

function readConfig(path: string): Stage3Config {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as Stage3Config;
}

export function readDeploymentAgentConfiguration(
  path = join(ROOT, "deployments", "testnet.json"),
): DeploymentAgentConfiguration {
  const deployment = JSON.parse(readFileSync(path, "utf8")) as {
    agent_configuration?: {
      voter_id?: unknown;
      model_signer?: { address_hex?: unknown; model?: unknown };
      pinned_agent?: { url?: unknown; sha256?: unknown };
    };
  };
  const configuration = deployment.agent_configuration;
  const voterId = configuration?.voter_id;
  const signerHex = configuration?.model_signer?.address_hex;
  const model = configuration?.model_signer?.model;
  const wasmUrl = configuration?.pinned_agent?.url;
  const wasmSha256 = configuration?.pinned_agent?.sha256;
  if (
    typeof voterId !== "string"
    || typeof signerHex !== "string"
    || typeof model !== "string"
    || typeof wasmUrl !== "string"
    || typeof wasmSha256 !== "string"
  ) {
    throw new Error("deployments/testnet.json has incomplete agent_configuration");
  }
  return {
    voter_id: voterId,
    model_signer_hex: signerHex.toLowerCase(),
    model,
    agent_wasm_url: wasmUrl,
    agent_wasm_sha256: wasmSha256,
  };
}

function readVoterDefaultsFromDeployment(config: Stage3Config): VoterDefaults {
  if (config.voter_id !== `s1.${config.seat_nft_id}`) {
    throw new Error("Voter defaults must be read from seat 1 of the configured seat NFT");
  }
  const agentConfiguration = readDeploymentAgentConfiguration();
  if (agentConfiguration.voter_id !== config.voter_id) {
    throw new Error("deployments/testnet.json agent_configuration does not match configured seat 1");
  }
  const defaults = {
    model_signer_hex: agentConfiguration.model_signer_hex,
    model: agentConfiguration.model,
    agent_wasm_url: agentConfiguration.agent_wasm_url,
    agent_wasm_sha256: agentConfiguration.agent_wasm_sha256,
  };
  if (!/^0x[0-9a-f]{40}$/.test(defaults.model_signer_hex)) {
    throw new Error("deployments/testnet.json has an invalid model signer address");
  }
  if (!defaults.agent_wasm_url.trim() || !/^[a-f0-9]{64}$/.test(defaults.agent_wasm_sha256)) {
    throw new Error("deployments/testnet.json has an invalid pinned agent WASM configuration");
  }
  return defaults;
}

function normalizeVoterDefaults(defaults: VoterDefaults): VoterDefaults {
  return {
    model_signer_hex: defaults.model_signer_hex.toLowerCase(),
    model: defaults.model,
    agent_wasm_url: defaults.agent_wasm_url,
    agent_wasm_sha256: defaults.agent_wasm_sha256,
  };
}

export function voterDefaultsMatch(
  current: VoterDefaults | null,
  expected: VoterDefaults,
): boolean {
  if (!current || typeof current.model_signer_hex !== "string") return false;
  return sameJsonValue(
    normalizeVoterDefaults(current),
    normalizeVoterDefaults(expected),
  );
}

export function assertVoterDefaultsMatch(
  current: VoterDefaults | null,
  expected: VoterDefaults,
  seatNftId: string,
): void {
  if (!voterDefaultsMatch(current, expected)) {
    throw new Error(
      `Live voter defaults on ${seatNftId} must match deployments/testnet.json before proposing the council policy`,
    );
  }
}

function assertTestnetConfig(config: Stage3Config): void {
  const host = new URL(config.rpc_url).hostname.toLowerCase();
  if (config.network !== "testnet" || !host.includes("testnet")) {
    throw new Error("Refusing to run unless the configured RPC is NEAR testnet");
  }
  for (const [name, accountId] of Object.entries({
    dao_id: config.dao_id,
    seat_nft_id: config.seat_nft_id,
    voter_id: config.voter_id,
    proposer_account_id: config.proposer_account_id,
    funder_account_id: config.funder_account_id,
    visitor_account_id: config.visitor_account_id,
  })) {
    if (!accountId.endsWith(".testnet")) {
      throw new Error(`${name} must be a .testnet account`);
    }
  }
  for (const path of [
    config.proposer_key_file,
    config.funder_key_file,
    config.runner_agent_key_file,
    config.visitor_key_file,
  ]) {
    if (path) assertExternalFile(path);
  }
}

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

async function findMatchingProposal(
  provider: JsonRpcProvider,
  daoId: string,
  kind: object,
): Promise<ProposalStatus | null> {
  const nextIdValue = await callView<number | string>(provider, daoId, "get_last_proposal_id", {});
  const nextId = Number(nextIdValue);
  if (!Number.isSafeInteger(nextId) || nextId < 0) {
    throw new Error("DAO returned an invalid get_last_proposal_id value");
  }

  let latest: ProposalStatus | null = null;
  for (let fromIndex = 0; fromIndex < nextId; fromIndex += 50) {
    const proposals = await callView<ProposalView[]>(provider, daoId, "get_proposals", {
      from_index: fromIndex,
      limit: Math.min(50, nextId - fromIndex),
    });
    for (const proposal of proposals) {
      if (sameJsonValue(proposal.kind, kind)) {
        const id = parseProposalId(proposal.id);
        if (latest === null || id > latest.id) {
          latest = { id, status: proposal.status };
        }
      }
    }
  }
  return latest;
}

async function sendActionsOnce(
  provider: JsonRpcProvider,
  credential: Credential,
  receiverId: string,
  actions: Action[],
): Promise<TransactionResult> {
  const publicKey = await credential.signer.getPublicKey();
  const accessKey = await provider.viewAccessKey(
    credential.accountId,
    publicKey,
    { finality: "optimistic" },
  );
  const block = await provider.viewBlock({ finality: "optimistic" });
  const transaction = createTransaction(
    credential.accountId,
    publicKey,
    receiverId,
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
  ].filter((failure) => failure !== undefined);
  if (failures.length > 0) {
    throw new Error(`Transaction failed: ${JSON.stringify(failures)}`);
  }

  let value: unknown = null;
  if (result.status?.SuccessValue) {
    const decoded = Buffer.from(result.status.SuccessValue, "base64").toString("utf8");
    try {
      value = JSON.parse(decoded);
    } catch {
      value = decoded;
    }
  }
  return { hash: baseEncode(hashBytes), value };
}

async function submitProposal(
  provider: JsonRpcProvider,
  credential: Credential,
  daoId: string,
  kind: object,
  description: string,
  bond: bigint,
  retryClosedMatch = false,
): Promise<{ proposalId: number; status: string; txHash?: string }> {
  const existing = await findMatchingProposal(provider, daoId, kind);
  if (existing && (!retryClosedMatch || existing.status === "InProgress")) {
    return { proposalId: existing.id, status: existing.status };
  }

  try {
    const result = await sendActionsOnce(
      provider,
      credential,
      daoId,
      [actionCreators.functionCall(
        "add_proposal",
        { proposal: { description, kind } },
        150n * TGAS,
        bond,
      )],
    );
    return {
      proposalId: parseProposalId(result.value),
      status: "submitted",
      txHash: result.hash,
    };
  } catch (error) {
    const landed = await findMatchingProposal(provider, daoId, kind);
    if (landed && (!retryClosedMatch || landed.status === "InProgress")) {
      return { proposalId: landed.id, status: landed.status };
    }
    throw new Error(
      `Proposal status is unknown after submission. No automatic resend was attempted: ${String(error)}`,
      { cause: error },
    );
  }
}

function policyProposalBond(policy: Policy): bigint {
  const bond = String(policy.proposal_bond);
  if (!/^\d+$/.test(bond)) throw new Error("DAO returned an invalid proposal_bond");
  return BigInt(bond);
}

const visitorRole = {
  name: "visitors",
  kind: "Everyone",
  permissions: ["call:AddProposal"],
  vote_policy: {},
};

function makeCouncilVotePolicy(): Record<string, unknown> {
  return Object.fromEntries(COUNCIL_GOVERNANCE_LABELS.map((label) => [
    label,
    {
      weight_kind: "RoleWeight",
      quorum: "0",
      threshold: [1, 2],
    },
  ]));
}

export function createDesiredPolicy(current: Policy): Policy {
  const councilRoles = current.roles.filter((role) => role.name === "council");
  if (councilRoles.length !== 1) {
    throw new Error(`Expected one council role, found ${councilRoles.length}`);
  }

  const permissions = [
    "*:AddProposal",
    "*:Finalize",
    ...COUNCIL_GOVERNANCE_LABELS.map((label) => `${label}:*`),
  ];
  let visitorsAdded = false;
  const roles = current.roles.flatMap((role) => {
    if (role.name === "council") {
      return [{
        ...role,
        permissions,
        vote_policy: makeCouncilVotePolicy(),
      }];
    }
    if (role.name === "visitors") {
      if (visitorsAdded) return [];
      visitorsAdded = true;
      return [visitorRole];
    }
    return [role];
  });
  if (!visitorsAdded) roles.push(visitorRole);

  return {
    ...current,
    roles,
    proposal_bond: PROPOSAL_BOND.toString(),
  };
}

function councilRole(policy: Policy): Policy["roles"][number] {
  const role = policy.roles.find((candidate) => candidate.name === "council");
  if (!role) throw new Error("DAO policy has no council role");
  return role;
}

function hasPermission(role: Policy["roles"][number], requested: string): boolean {
  const [requestedLabel, requestedAction] = requested.split(":");
  return role.permissions.some((permission) => {
    const [grantedLabel, grantedAction, extra] = permission.split(":");
    return extra === undefined
      && (grantedLabel === "*" || grantedLabel === requestedLabel)
      && (grantedAction === "*" || grantedAction === requestedAction);
  });
}

export function assertCouncilCanApproveVoterDefaults(policy: Policy): void {
  if (!hasPermission(councilRole(policy), "call:VoteApprove")) {
    throw new Error(
      "Voter defaults must be set first, before the council loses call:VoteApprove",
    );
  }
}

export async function checkVoterDefaultsProposalState(
  current: VoterDefaults | null,
  expected: VoterDefaults,
  readPolicy: () => Promise<Policy>,
): Promise<{ status: "already_set" } | { status: "write"; policy: Policy }> {
  if (voterDefaultsMatch(current, expected)) return { status: "already_set" };
  const policy = await readPolicy();
  assertCouncilCanApproveVoterDefaults(policy);
  return { status: "write", policy };
}

export function assertVisitorApplicationsReady(policy: Policy): void {
  if (hasPermission(councilRole(policy), "call:VoteApprove")) {
    throw new Error(
      "DAO policy still gives the council call:VoteApprove. Approve the policy change before visitor apply",
    );
  }
}

export function createPolicyDiff(current: Policy, desired: Policy): object {
  const changedRoles: Record<string, { before: unknown[]; after: unknown[] }> = {};
  const roleNames = new Set([
    ...current.roles.map((role) => role.name),
    ...desired.roles.map((role) => role.name),
  ]);
  for (const name of roleNames) {
    const before = current.roles.filter((role) => role.name === name);
    const after = desired.roles.filter((role) => role.name === name);
    if (!sameJsonValue(before, after)) changedRoles[name] = { before, after };
  }
  return {
    ...(sameJsonValue(current.proposal_bond, desired.proposal_bond)
      ? {}
      : { proposal_bond: { before: current.proposal_bond, after: desired.proposal_bond } }),
    roles: changedRoles,
  };
}

async function proposePolicyChanges(
  provider: JsonRpcProvider,
  credential: Credential,
  config: Stage3Config,
): Promise<void> {
  const expectedDefaults = readVoterDefaultsFromDeployment(config);
  const currentDefaults = await callView<VoterDefaults | null>(
    provider,
    config.seat_nft_id,
    "get_voter_defaults",
    {},
  );
  assertVoterDefaultsMatch(currentDefaults, expectedDefaults, config.seat_nft_id);

  const current = await callView<Policy>(provider, config.dao_id, "get_policy", {});
  const desired = createDesiredPolicy(current);
  if (sameJsonValue(current, desired)) {
    process.stdout.write(`${JSON.stringify({
      status: "verified",
      message: "Live DAO policy matches the desired policy",
    })}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    status: "policy_diff",
    diff: createPolicyDiff(current, desired),
  }, null, 2)}\n`);
  const proposal = await submitProposal(
    provider,
    credential,
    config.dao_id,
    { ChangePolicy: { policy: desired } },
    "Set council governance policy and visitor proposal bond",
    policyProposalBond(current),
  );
  if (proposal.status === "Approved") {
    const applied = await callView<Policy>(provider, config.dao_id, "get_policy", {});
    if (!sameJsonValue(applied, desired)) {
      throw new Error(
        `Policy proposal ${proposal.proposalId} is approved, but live get_policy does not match the desired policy`,
      );
    }
    process.stdout.write(`${JSON.stringify({
      proposal_id: proposal.proposalId,
      status: "verified",
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    proposal_id: proposal.proposalId,
    status: proposal.status,
  })}\n`);
}

async function proposeVoterDefaults(
  provider: JsonRpcProvider,
  credential: Credential,
  config: Stage3Config,
): Promise<void> {
  const defaults = readVoterDefaultsFromDeployment(config);
  const current = await callView<typeof defaults | null>(
    provider,
    config.seat_nft_id,
    "get_voter_defaults",
    {},
  );
  const decision = await checkVoterDefaultsProposalState(
    current,
    defaults,
    () => callView<Policy>(provider, config.dao_id, "get_policy", {}),
  );
  if (decision.status === "already_set") {
    process.stdout.write(`${JSON.stringify({ status: "already_set" })}\n`);
    return;
  }

  const policy = decision.policy;
  const kind = createVoterDefaultsProposalKind(config.seat_nft_id, defaults);
  const proposal = await submitProposal(
    provider,
    credential,
    config.dao_id,
    kind,
    "Set defaults for new voter accounts",
    policyProposalBond(policy),
  );
  process.stdout.write(`${JSON.stringify({ proposal_id: proposal.proposalId, status: proposal.status })}\n`);
}

export function createVoterDefaultsProposalKind(
  seatNftId: string,
  defaults: Omit<DeploymentAgentConfiguration, "voter_id">,
): object {
  return {
    FunctionCall: {
      receiver_id: seatNftId,
      actions: [{
        method_name: "set_voter_defaults",
        args: Buffer.from(JSON.stringify({ defaults })).toString("base64"),
        deposit: "0",
        gas: String(50n * TGAS),
      }],
    },
  };
}

function keyIsPresent(error: unknown): boolean {
  const details = error && typeof error === "object"
    ? error as { type?: unknown; name?: unknown; message?: unknown }
    : undefined;
  return /UNKNOWN_ACCESS_KEY|AccessKeyDoesNotExist|access key[^\n]*(?:not found|does not exist)/i
    .test([details?.type, details?.name, details?.message, error].map(String).join(" "));
}

async function viewAccountOrNull(
  provider: JsonRpcProvider,
  accountId: string,
): Promise<{ amount: string | bigint } | null> {
  try {
    return await provider.viewAccount(accountId, { finality: "optimistic" });
  } catch (error) {
    if (isMissingAccountError(error)) return null;
    throw error;
  }
}

async function hasAccessKey(
  provider: JsonRpcProvider,
  accountId: string,
  publicKey: Awaited<ReturnType<KeyPairSigner["getPublicKey"]>>,
): Promise<boolean> {
  try {
    const accessKey = await provider.viewAccessKey(accountId, publicKey, { finality: "optimistic" });
    return accessKey.permission === "FullAccess";
  } catch (error) {
    if (keyIsPresent(error)) return false;
    throw error;
  }
}

async function ensureVisitorAccount(
  provider: JsonRpcProvider,
  funder: Credential,
  visitorId: string,
  visitorKey: ReturnType<typeof loadCredential>,
): Promise<void> {
  const account = await viewAccountOrNull(provider, visitorId);
  const hasVisitorKey = account
    ? await hasAccessKey(provider, visitorId, visitorKey.publicKey)
    : false;
  if (account && !hasVisitorKey) {
    throw new Error(`Visitor account ${visitorId} does not have the configured full-access key`);
  }
  if (!account) {
    try {
      await sendActionsOnce(
        provider,
        funder,
        visitorId,
        [
          actionCreators.createAccount(),
          actionCreators.transfer(VISITOR_FUNDING),
          actionCreators.addKey(visitorKey.publicKey, actionCreators.fullAccessKey()),
        ],
      );
    } catch (error) {
      const landedAccount = await viewAccountOrNull(provider, visitorId);
      const landedKey = landedAccount
        ? await hasAccessKey(provider, visitorId, visitorKey.publicKey)
        : false;
      if (!landedAccount || !landedKey) {
        throw new Error(
          `Visitor account creation status is unknown. No automatic resend was attempted: ${String(error)}`,
          { cause: error },
        );
      }
    }
  }

  const fundedAccount = await viewAccountOrNull(provider, visitorId);
  if (!fundedAccount) throw new Error(`Could not confirm visitor account ${visitorId}`);
  const balance = BigInt(fundedAccount.amount);
  if (balance < VISITOR_MINIMUM_BALANCE) {
    const transfer = VISITOR_MINIMUM_BALANCE - balance;
    try {
      await sendActionsOnce(
        provider,
        funder,
        visitorId,
        [actionCreators.transfer(transfer)],
      );
    } catch (error) {
      const after = await viewAccountOrNull(provider, visitorId);
      if (!after || BigInt(after.amount) < VISITOR_MINIMUM_BALANCE) {
        throw new Error(
          `Visitor funding status is unknown. Check the account before resending: ${String(error)}`,
          { cause: error },
        );
      }
    }
  }
}

export function createApplicationProposalKind(seatNftId: string, applicant: string): object {
  return {
    FunctionCall: {
      receiver_id: seatNftId,
      actions: [{
        method_name: "approve_application",
        args: Buffer.from(JSON.stringify({
          applicant,
          expires_in_ns: APPLICATION_DURATION_NS,
        })).toString("base64"),
        deposit: "0",
        // Delegate votes forward only 150 Tgas to the DAO, so this action must stay small.
        gas: APPLICATION_PROPOSAL_ACTION_GAS.toString(),
      }],
    },
  };
}

async function getApplicationExpiry(
  provider: JsonRpcProvider,
  seatNftId: string,
  applicant: string,
): Promise<bigint | null> {
  const value = await callView<string | number | null>(
    provider,
    seatNftId,
    "get_application_approval",
    { applicant },
  );
  if (value === null) return null;
  const expiration = String(value);
  if (!/^\d+$/.test(expiration)) {
    throw new Error("Seat NFT returned an invalid application expiration");
  }
  return BigInt(expiration);
}

async function activeApplicationExpiry(
  provider: JsonRpcProvider,
  seatNftId: string,
  applicant: string,
): Promise<bigint | null> {
  const expiresAt = await getApplicationExpiry(provider, seatNftId, applicant);
  if (expiresAt === null) return null;
  const block = await provider.viewBlock({ finality: "optimistic" });
  return BigInt(block.header.timestamp_nanosec) < expiresAt ? expiresAt : null;
}

async function readClaimedSeat(
  provider: JsonRpcProvider,
  seatNftId: string,
  applicant: string,
): Promise<{ token_id: string; voter_id: string } | null> {
  const tokens = await callView<Array<{ token_id: string }>>(
    provider,
    seatNftId,
    "nft_tokens_for_owner",
    { account_id: applicant, from_index: "0", limit: 10 },
  );
  const token = tokens[0];
  if (!token) return null;
  const seat = await callView<{ voter_id: string } | null>(
    provider,
    seatNftId,
    "get_seat",
    { token_id: token.token_id },
  );
  if (!seat?.voter_id) {
    throw new Error(`Seat ${token.token_id} has no voter account`);
  }
  return { token_id: token.token_id, voter_id: seat.voter_id };
}

async function applyAsVisitor(
  provider: JsonRpcProvider,
  config: Stage3Config,
): Promise<void> {
  if (!config.visitor_account_id.endsWith(`.${config.funder_account_id}`)) {
    throw new Error("visitor_account_id must be an immediate subaccount of funder_account_id");
  }
  const visitorKeyPath = assertExternalFile(
    config.visitor_key_file ?? join(homedir(), "near-spike", "secrets", "visitor-apply.json"),
  );
  writeKeyFile(visitorKeyPath, config.visitor_account_id);
  const visitor = loadCredential(visitorKeyPath, config.visitor_account_id);
  const funder = loadCredential(config.funder_key_file, config.funder_account_id);
  const policy = await callView<Policy>(provider, config.dao_id, "get_policy", {});
  assertVisitorApplicationsReady(policy);
  const visitorsRoleIsReady = policy.roles.some((role) =>
    role.name === "visitors"
      && role.kind === "Everyone"
      && role.permissions.includes("call:AddProposal"));
  if (!visitorsRoleIsReady) {
    throw new Error("DAO visitors role must be approved before visitor apply");
  }
  if (policyProposalBond(policy) !== PROPOSAL_BOND) {
    throw new Error("DAO proposal_bond must be 0.1 NEAR before visitor apply");
  }

  await ensureVisitorAccount(provider, funder, config.visitor_account_id, visitor);
  const activeApproval = await activeApplicationExpiry(
    provider,
    config.seat_nft_id,
    config.visitor_account_id,
  );
  if (activeApproval !== null) {
    process.stdout.write(`${JSON.stringify({
      status: "already_approved",
      expires_at: activeApproval.toString(),
    })}\n`);
    return;
  }

  const kind = createApplicationProposalKind(config.seat_nft_id, config.visitor_account_id);
  const existing = await findMatchingProposal(provider, config.dao_id, kind);
  if (existing?.status === "InProgress") {
    process.stdout.write(`${JSON.stringify({ proposal_id: existing.id, status: existing.status })}\n`);
    return;
  }
  const proposal = await submitProposal(
    provider,
    visitor,
    config.dao_id,
    kind,
    `Apply for a seat for ${config.visitor_account_id}`,
    PROPOSAL_BOND,
    true,
  );
  process.stdout.write(`${JSON.stringify({ proposal_id: proposal.proposalId, status: proposal.status })}\n`);
}

async function claimSeatAsVisitor(
  provider: JsonRpcProvider,
  config: Stage3Config,
): Promise<void> {
  const visitorKeyPath = assertExternalFile(
    config.visitor_key_file ?? join(homedir(), "near-spike", "secrets", "visitor-apply.json"),
  );
  const visitor = loadCredential(visitorKeyPath, config.visitor_account_id);
  const runner = loadCredential(config.runner_agent_key_file, "runner-agent.testnet", false);
  const account = await viewAccountOrNull(provider, config.visitor_account_id);
  if (!account) throw new Error(`Visitor account ${config.visitor_account_id} does not exist`);
  if (!await hasAccessKey(provider, config.visitor_account_id, visitor.publicKey)) {
    throw new Error(`Visitor account ${config.visitor_account_id} does not have the configured full-access key`);
  }
  if (BigInt(account.amount) < VISITOR_CLAIM_DEPOSIT + VISITOR_GAS_RESERVE) {
    throw new Error("Visitor account does not have enough NEAR for the claim deposit and gas reserve");
  }

  const currentSeat = await readClaimedSeat(
    provider,
    config.seat_nft_id,
    config.visitor_account_id,
  );
  if (currentSeat) {
    process.stdout.write(`${JSON.stringify({ status: "already_claimed", ...currentSeat })}\n`);
    return;
  }
  if (await activeApplicationExpiry(provider, config.seat_nft_id, config.visitor_account_id) === null) {
    throw new Error("Visitor has no active application approval");
  }

  let result: TransactionResult;
  try {
    result = await sendActionsOnce(
      provider,
      visitor,
      config.seat_nft_id,
      [actionCreators.functionCall(
        "claim_seat",
        { agent_public_key: runner.publicKey.toString() },
        CLAIM_SEAT_GAS,
        VISITOR_CLAIM_DEPOSIT,
      )],
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Transaction failed:")) {
      throw error;
    }
    const landedSeat = await readClaimedSeat(
      provider,
      config.seat_nft_id,
      config.visitor_account_id,
    );
    if (landedSeat) {
      process.stdout.write(`${JSON.stringify({ status: "claimed", ...landedSeat })}\n`);
      return;
    }
    throw new Error(
      `Seat claim status is unknown. Check the visitor's seats before retrying: ${String(error)}`,
      { cause: error },
    );
  }

  const claimedSeat = await readClaimedSeat(
    provider,
    config.seat_nft_id,
    config.visitor_account_id,
  );
  if (!claimedSeat) throw new Error("Seat claim completed but no owned seat was returned");
  process.stdout.write(`${JSON.stringify({
    status: "claimed",
    ...claimedSeat,
    tx_hash: result.hash,
  })}\n`);
}

export async function main(args: string[]): Promise<void> {
  const command = args[0];
  if (command === "generate-runner-key") {
    const outputIndex = args.indexOf("--output");
    const outputPath = outputIndex >= 0
      ? args[outputIndex + 1]
      : defaultRunnerKeyPath();
    if (!outputPath) throw new Error("--output requires a path");
    const publicKey = writeKeyFile(outputPath);
    process.stdout.write(`${publicKey}\n`);
    return;
  }
  if (!["propose-policy", "propose-voter-defaults", "apply", "apply-visitor", "claim"].includes(command ?? "")) {
    throw new Error(
      "Usage: stage3-testnet.js generate-runner-key [--output path] | propose-voter-defaults --config path | propose-policy --config path | apply --config path | claim --config path",
    );
  }
  const configIndex = args.indexOf("--config");
  if (configIndex < 0 || !args[configIndex + 1]) {
    throw new Error(`${command} requires --config /path/to/stage3-testnet.json`);
  }
  const config = readConfig(args[configIndex + 1]);
  assertTestnetConfig(config);
  const provider = new JsonRpcProvider({ url: config.rpc_url }, { retries: 0 });
  if (command === "propose-policy") {
    const credential = loadCredential(config.proposer_key_file, config.proposer_account_id);
    await proposePolicyChanges(provider, credential, config);
  } else if (command === "propose-voter-defaults") {
    const credential = loadCredential(config.proposer_key_file, config.proposer_account_id);
    await proposeVoterDefaults(provider, credential, config);
  } else if (command === "claim") {
    await claimSeatAsVisitor(provider, config);
  } else {
    await applyAsVisitor(provider, config);
  }
}
