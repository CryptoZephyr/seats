import { useEffect, useState, type ReactNode } from "react";
import { getAccountInfo, getGasPrice } from "./chain/rpc";
import {
  contractErrorCode,
  explorerTxUrl,
  friendlyContractError,
  type FunctionCallRequest,
} from "./chain/transactions";
import s from "./screens.module.css";

export class InsufficientFundsError extends Error {}

export const TESTNET_FAUCET_URL = "https://near-faucet.io/";

export function isInsufficientFundsError(error: unknown): error is InsufficientFundsError {
  return error instanceof InsufficientFundsError;
}

export function near(value: bigint): string {
  const whole = value / 10n ** 24n;
  const fraction = (value % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function friendly(error: unknown): string {
  if (error instanceof InsufficientFundsError) return error.message;
  const code = contractErrorCode(error);
  if (code) return friendlyContractError(code);
  if (error instanceof Error && /timed? ?out|failed to fetch|networkerror|network request failed|network error/i.test(error.message)) {
    return "The wallet didn't confirm the result. Check the transaction before trying again.";
  }
  return error instanceof Error ? error.message : "The request couldn't be completed.";
}

export async function checkFunds(accountId: string, request: FunctionCallRequest): Promise<boolean> {
  const [account, gasPrice] = await Promise.all([getAccountInfo(accountId), getGasPrice()]);
  const spendable = BigInt(account.amount) - BigInt(account.storage_usage) * 10n ** 19n;
  return spendable >= request.deposit + request.gas * gasPrice;
}

export function useGasEstimate(gas: bigint): string | null {
  const [estimate, setEstimate] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getGasPrice().then((price) => {
      if (active) setEstimate(near(gas * price));
    }).catch(() => { if (active) setEstimate(null); });
    return () => { active = false; };
  }, [gas]);
  return estimate;
}

export function TxLink({ hash }: { hash: string }) {
  return <a className={s.txLink} href={explorerTxUrl(hash)} target="_blank" rel="noreferrer">View transaction</a>;
}

export function FaucetLink() {
  return <a className={s.txLink} href={TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">Get testnet NEAR from the faucet</a>;
}

export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return <header className={s.pageHead}><p className={s.eyebrow}>{eyebrow}</p><h1>{title}</h1>{children}</header>;
}
