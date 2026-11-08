import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { setupWalletSelector, type SignedMessage, type WalletSelector } from "@near-wallet-selector/core";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { loadClubSnapshot } from "./club";
import { chainConfig } from "./config";
import { callView } from "./rpc";
import {
  sendFunctionCall,
  voterCall,
  type FunctionCallRequest,
  type FunctionCallResult,
  type VoterArgs,
  type VoterMethod,
} from "./transactions";
import type { NftToken } from "./types";

interface Membership {
  status: "idle" | "loading" | "error" | "ready";
  error?: Error;
  seatIds: string[];
  isVoterController: boolean;
}

interface ViewerValue {
  accountId: string | null;
  isSeatHolder: boolean;
  seatIds: string[];
  isVoterController: boolean;
  isLoading: boolean;
  walletReady: boolean;
  error: Error | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  retry: () => void;
  callVoter: <Method extends VoterMethod>(
    voterId: string,
    method: Method,
    args: VoterArgs<Method>,
  ) => Promise<string>;
  callContract: (request: FunctionCallRequest) => Promise<FunctionCallResult>;
  signMessage: (message: string, nonce: Uint8Array, recipient: string) => Promise<SignedMessage>;
}

const ViewerContext = createContext<ViewerValue | null>(null);

async function ownedTokens(accountId: string): Promise<NftToken[]> {
  const tokens: NftToken[] = [];
  let fromIndex = 0;

  while (true) {
    const page = await callView(chainConfig.seatNftAccountId, "nft_tokens_for_owner", {
      account_id: accountId,
      from_index: String(fromIndex),
      limit: 100,
    });
    tokens.push(...page);
    if (page.length < 100) return tokens;
    fromIndex += page.length;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [selectorAttempt, setSelectorAttempt] = useState(0);
  const [membershipAttempt, setMembershipAttempt] = useState(0);
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<Error | null>(null);
  const [membership, setMembership] = useState<Membership>({
    status: "idle",
    seatIds: [],
    isVoterController: false,
  });

  useEffect(() => {
    let active = true;
    let instance: WalletSelector | null = null;

    const syncAccount = () => {
      if (!active || !instance) return;
      const activeAccount = instance.store.getState().accounts.find((account) => account.active);
      setAccountId(activeAccount?.accountId ?? null);
    };

    const onSignedIn = () => syncAccount();
    const onSignedOut = () => syncAccount();
    const onAccountsChanged = () => syncAccount();

    async function initialize() {
      try {
        instance = await setupWalletSelector({
          network: {
            networkId: "testnet",
            nodeUrl: chainConfig.rpcUrl,
            helperUrl: "https://helper.testnet.near.org",
            explorerUrl: "https://testnet.nearblocks.io",
            indexerUrl: "https://test.api.fastnear.com/v0",
          },
          modules: [setupIntearWallet()],
        });
        if (!active) return;

        const walletModal = setupModal(instance, {
          contractId: chainConfig.seatNftAccountId,
          methodNames: ["nft_tokens", "nft_tokens_for_owner", "nft_metadata", "get_seat"],
        });
        instance.on("signedIn", onSignedIn);
        instance.on("signedOut", onSignedOut);
        instance.on("accountsChanged", onAccountsChanged);
        setSelector(instance);
        setModal(walletModal);
        setWalletError(null);
        syncAccount();
      } catch (error) {
        if (active) {
          setWalletError(error instanceof Error ? error : new Error("Wallet Selector could not be initialized."));
        }
      }
    }

    void initialize();
    return () => {
      active = false;
      instance?.off("signedIn", onSignedIn);
      instance?.off("signedOut", onSignedOut);
      instance?.off("accountsChanged", onAccountsChanged);
    };
  }, [selectorAttempt]);

  useEffect(() => {
    let active = true;
    if (!selector || !accountId) {
      setMembership({ status: "idle", seatIds: [], isVoterController: false });
      return () => {
        active = false;
      };
    }

    setMembership({ status: "loading", seatIds: [], isVoterController: false });
    Promise.allSettled([ownedTokens(accountId), loadClubSnapshot()]).then(
      ([tokensResult, snapshotResult]) => {
        if (!active) return;
        if (tokensResult.status === "rejected") {
          setMembership({
            status: "error",
            error: tokensResult.reason instanceof Error
              ? tokensResult.reason
              : new Error("Your seat information could not be loaded."),
            seatIds: [],
            isVoterController: false,
          });
          return;
        }

        const snapshot = snapshotResult.status === "fulfilled" ? snapshotResult.value : null;
        setMembership({
          status: "ready",
          seatIds: tokensResult.value.map((token) => token.token_id),
          isVoterController:
            snapshot?.seats.some((seat) => seat.controller === accountId) ?? false,
        });
      },
    );

    return () => {
      active = false;
    };
  }, [accountId, membershipAttempt, selector]);

  const signIn = useCallback(() => modal?.show(), [modal]);
  const signOut = useCallback(async () => {
    if (!selector) return;
    try {
      const wallet = await selector.wallet();
      await wallet.signOut();
      setAccountId(null);
    } catch (error) {
      setWalletError(error instanceof Error ? error : new Error("Wallet sign-out failed."));
    }
  }, [selector]);
  const retry = useCallback(() => {
    if (walletError || !selector) {
      setSelectorAttempt((value) => value + 1);
      return;
    }
    setMembershipAttempt((value) => value + 1);
  }, [selector, walletError]);
  const callVoter = useCallback(
    async <Method extends VoterMethod,>(
      voterId: string,
      method: Method,
      args: VoterArgs<Method>,
    ) => {
      if (!accountId) throw new Error("Sign in to change this vote.");
      if (!selector) throw new Error("Wallet isn't ready. Try again.");
      const wallet = await selector.wallet();
      return voterCall(wallet, accountId, voterId, method, args);
    },
    [accountId, selector],
  );
  const callContract = useCallback(
    async (request: FunctionCallRequest) => {
      if (!accountId) throw new Error("Sign in to continue.");
      if (!selector) throw new Error("Wallet isn't ready. Try again.");
      const wallet = await selector.wallet();
      return sendFunctionCall(wallet, accountId, request);
    },
    [accountId, selector],
  );
  const signMessage = useCallback(async (message: string, nonce: Uint8Array, recipient: string) => {
    if (!accountId) throw new Error("Sign in to save your delegate's brief.");
    if (!selector) throw new Error("Wallet isn't ready. Try again.");
    const wallet = await selector.wallet();
    const signed = await wallet.signMessage({ message, nonce: nonce as Buffer, recipient });
    if (!signed || signed.accountId !== accountId) throw new Error("The wallet didn't sign for the connected account.");
    return signed;
  }, [accountId, selector]);

  const value: ViewerValue = {
    accountId,
    isSeatHolder: membership.seatIds.length > 0,
    seatIds: membership.seatIds,
    isVoterController: membership.isVoterController,
    isLoading: (!selector && !walletError) || membership.status === "loading",
    walletReady: selector !== null && modal !== null,
    error: walletError ?? membership.error ?? null,
    signIn,
    signOut,
    retry,
    callVoter,
    callContract,
    signMessage,
  };

  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useViewer(): ViewerValue {
  const viewer = useContext(ViewerContext);
  if (!viewer) throw new Error("useViewer must be used inside WalletProvider.");
  return viewer;
}
