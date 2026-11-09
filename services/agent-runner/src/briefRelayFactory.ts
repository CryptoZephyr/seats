import { createBriefHandler, type BriefRelayRpc } from "./briefRelay.js";
import { encryptProfileSecrets, fetchOutlayerSecretsPubkey } from "./profileCrypto.js";
import type { NearAgentRpc } from "./rpc.js";

type BriefRelayEnv = NodeJS.ProcessEnv;

export function createBriefRelayFromEnv(
  env: BriefRelayEnv,
  rpc: NearAgentRpc,
  options: { allowSameOrigin?: boolean } = {},
) {
  const ownerAccountId = env.BRIEF_OWNER_ACCOUNT_ID?.trim();
  const apiKey = env.NEAR_AI_API_KEY?.trim();
  const seatNftId = env.SEAT_NFT_ID?.trim();
  if (!ownerAccountId || !apiKey || !seatNftId) {
    throw new Error("Brief relay environment is incomplete");
  }

  const briefRpc: BriefRelayRpc = {
    isFullAccessKey: rpc.isFullAccessKey.bind(rpc),
    getTokenOwner: (tokenId) => rpc.getTokenOwner(seatNftId, tokenId),
    getSeatVoterId: (tokenId) => rpc.getSeatVoterId(seatNftId, tokenId),
    getVoterController: rpc.getVoterController.bind(rpc),
    getAccountInfo: rpc.getAccountInfo.bind(rpc),
    getAgentWasmSha256: () => rpc.getAgentWasmSha256(seatNftId),
    profileExists: (profileOwnerId, profile, agentWasmSha256) =>
      rpc.profileExists(profileOwnerId, profile, agentWasmSha256),
    storeProfile: async (profile, secretsJson, agentWasmSha256) => {
      const pubkey = await fetchOutlayerSecretsPubkey(
        ownerAccountId,
        profile,
        secretsJson,
        agentWasmSha256,
      );
      const encrypted = encryptProfileSecrets(pubkey, secretsJson);
      return rpc.storeProfile(ownerAccountId, profile, encrypted, agentWasmSha256);
    },
  };

  return createBriefHandler({
    ownerAccountId,
    apiKey,
    recipient: env.BRIEF_SIGN_RECIPIENT?.trim() || "seats-agent-runner",
    webOrigins: env.WEB_ORIGINS?.trim() || "http://127.0.0.1:5199,http://localhost:5199",
    allowSameOrigin: options.allowSameOrigin,
    rpc: briefRpc,
  });
}
