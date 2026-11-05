import type { JsonRpcProvider } from "@near-js/providers";
import type { KeyPairSigner } from "@near-js/signers";

type PublicKey = Awaited<ReturnType<KeyPairSigner["getPublicKey"]>>;

export function selectNextNonce(cachedNonce: bigint | undefined, onchainNonce: bigint): bigint {
  const cachedNext = cachedNonce === undefined ? onchainNonce + 1n : cachedNonce + 1n;
  const onchainNext = onchainNonce + 1n;
  return cachedNext > onchainNext ? cachedNext : onchainNext;
}

export async function sendWithNonceRetry<T>(
  provider: Pick<JsonRpcProvider, "viewAccessKey">,
  accountId: string,
  publicKey: PublicKey,
  nonceCache: Map<string, bigint>,
  send: (nonce: bigint) => Promise<T>,
): Promise<T> {
  const cacheKey = `${accountId}:${publicKey.toString()}`;
  const attempt = async (): Promise<T> => {
    const accessKey = await provider.viewAccessKey(accountId, publicKey, { finality: "optimistic" });
    const nonce = selectNextNonce(nonceCache.get(cacheKey), BigInt(accessKey.nonce));
    nonceCache.set(cacheKey, nonce);
    return send(nonce);
  };
  try {
    return await attempt();
  } catch (error) {
    const message = error instanceof Error
      ? `${error.name} ${error.message}`
      : JSON.stringify(error) ?? String(error);
    if (!/InvalidNonce|Transaction nonce .* must be larger than nonce of the used access key/i.test(message)) {
      throw error;
    }
    return attempt();
  }
}
