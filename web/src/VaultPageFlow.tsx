import { useEffect, useState } from "react";
import { useViewer } from "./chain/WalletProvider";
import { useClubData } from "./chain/useClubData";
import { estimateVaultExecutionCost, getTransactionStatus } from "./chain/rpc";
import { buildVaultRequest, contractErrorCode, VAULT_REQUEST_GAS } from "./chain/transactions";
import { decryptVaultResponse, generateVaultKeyPair, type VaultCiphertext } from "./chain/vaultCrypto";
import { ErrorStatus, GraphicButton, LoadingStatus, RefusedStamp, RuledSection } from "./ui";
import {
  checkFunds,
  FaucetLink,
  friendly,
  InsufficientFundsError,
  isInsufficientFundsError,
  near,
  PageHead,
  TxLink,
  useGasEstimate,
} from "./flowCommon";
import s from "./screens.module.css";

function payloadFromOutcome(outcome: unknown): VaultCiphertext | null {
  const receipts = (outcome as {
    receipts_outcome?: Array<{ outcome?: { status?: { SuccessValue?: string } } }>;
  }).receipts_outcome ?? [];
  for (const receipt of receipts) {
    const value = receipt.outcome?.status?.SuccessValue;
    if (!value) continue;
    try { return JSON.parse(atob(value)) as VaultCiphertext; } catch { continue; }
  }
  return null;
}

export function VaultPageFlow() {
  const viewer = useViewer();
  const state = useClubData();
  const [cost, setCost] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsFaucet, setNeedsFaucet] = useState(false);
  const [notAllowed, setNotAllowed] = useState(false);
  const [text, setText] = useState("");
  const [hash, setHash] = useState("");
  const gasEstimate = useGasEstimate(VAULT_REQUEST_GAS);
  useEffect(() => {
    let active = true;
    void estimateVaultExecutionCost({
      max_execution_seconds: 10,
      max_instructions: 1_000_000_000,
      max_memory_mb: 128,
    }).then((value) => { if (active) setCost(value); })
      .catch(() => { if (active) setCost("error"); });
    return () => { active = false; };
  }, []);

  const openVault = async () => {
    setError("");
    setNeedsFaucet(false);
    setNotAllowed(false);
    setText("");
    setHash("");
    setBusy(true);
    try {
      if (!viewer.accountId || !viewer.isSeatHolder) throw new Error("ERR_NO_SEAT");
      if (!cost || cost === "error") throw new Error("OutLayer's execution cost estimate is unavailable.");
      const keyPair = generateVaultKeyPair();
      const requester = Array.from(keyPair.publicKey, (byte) => byte.toString(16).padStart(2, "0")).join("");
      const request = buildVaultRequest(requester, cost);
      if (!await checkFunds(viewer.accountId, request)) {
        throw new InsufficientFundsError(`Your balance must cover the ${near(request.deposit)} NEAR deposit and about ${gasEstimate ?? "the current"} testnet NEAR for the network fee.`);
      }
      const tx = await viewer.callContract(request);
      setHash(tx.hash);
      let payload = payloadFromOutcome(tx.outcome);
      if (!payload) payload = payloadFromOutcome(await getTransactionStatus(tx.hash, viewer.accountId));
      if (!payload) throw new Error("The final transaction doesn't contain a readable Vault result.");
      if (!payload.ok) throw new Error(payload.error || "ERR_NO_SEAT");
      setText(decryptVaultResponse(payload, keyPair.secretKey));
    } catch (cause) {
      state.retry();
      viewer.retry();
      setNeedsFaucet(isInsufficientFundsError(cause));
      const code = contractErrorCode(cause);
      const causeText = cause instanceof Error ? cause.message : "";
      if (code === "ERR_NO_SEAT" || causeText === "ERR_NO_SEAT") {
        setNotAllowed(true);
      } else {
        setError(friendly(cause));
      }
    } finally { setBusy(false); }
  };

  return <main className={s.page}>
    <PageHead eyebrow={viewer.seatIds.length === 1 ? `Seat ${viewer.seatIds[0]}` : "Your seat"} title="Club vault" />
    <RuledSection inset>
      {!viewer.accountId ? <p className={s.muted}>Sign in with the wallet that holds your seat to check vault access.</p>
        : viewer.isLoading ? <LoadingStatus>Checking your seats on testnet…</LoadingStatus>
        : !viewer.isSeatHolder ? <p><RefusedStamp>Not allowed</RefusedStamp> Only current seat holders can open the vault.</p>
        : <>
          <p>The request is encrypted in your browser. Your private key stays in memory and is discarded when you leave this page.</p>
          <p>Expected execution charge: about 0.002 testnet NEAR. The deposit is estimated live and most is refunded.</p>
          {cost && cost !== "error" && <p>Deposit: {near(BigInt(cost) + 500_000_000_000n)} NEAR.</p>}
          <p>Network fee about {gasEstimate ? `${gasEstimate} testnet NEAR` : "checking testnet network fee"}.</p>
          <GraphicButton glyph="vault" onClick={() => void openVault()} disabled={busy || cost === null || cost === "error"}>Open vault</GraphicButton>
          {text && <pre className={s.briefInput}>{text}</pre>}
        </>}
      {cost === null && <LoadingStatus>Checking OutLayer's current execution estimate…</LoadingStatus>}
      {busy && <LoadingStatus>Waiting for your wallet and the vault job…</LoadingStatus>}
      {notAllowed && <p><RefusedStamp>Not allowed</RefusedStamp> The vault job refused this account.</p>}
      {error && <ErrorStatus>{error}{needsFaucet && <> <FaucetLink /></>}</ErrorStatus>}
      {hash && <p><TxLink hash={hash} /></p>}
    </RuledSection>
  </main>;
}
