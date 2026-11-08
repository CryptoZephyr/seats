import { useEffect, useState, type JSX } from "react";
import {
  AIReceiptPage,
  ClubPage,
  DelegateBrief,
  MySeat,
  ProposalVote,
  ReceiptPage,
  StatesPage,
} from "./screens";
import { ApplyClaimPage } from "./ApplyClaimPage";
import { BuySeatFlow } from "./BuySeatFlow";
import { SellSeatFlow } from "./SellSeatFlow";
import { VaultPageFlow } from "./VaultPageFlow";
import { DocsRoute } from "./components/docs/DocPage";
import { LicensePage, PolicyPage } from "./legal";
import { SeatHistoryPage } from "./SeatHistoryPage";
import { WalletProvider } from "./chain/WalletProvider";
import { SiteFooter, SiteHeader, TestnetStrip } from "./ui";

type Route =
  | "club"
  | "apply"
  | "seat"
  | "seat-history"
  | "brief"
  | "vote"
  | "vote-proposal"
  | "vote-closed"
  | "aireceipt"
  | "vault"
  | "sell"
  | "buy"
  | "receipt-vote"
  | "receipt-sale"
  | "receipt-buy"
  | "receipt-vault"
  | "states"
  | "docs"
  | "license"
  | "policy";

export function parseRoute(hash = window.location.hash): { route: Route; proposalId?: number; tokenId?: string } {
  const h = hash.replace(/^#\/?/, "");
  const seatHistory = h.match(/^seat\/(\d+)\/history$/);
  if (seatHistory) {
    return { route: "seat-history", tokenId: seatHistory[1] };
  }
  const proposalSeatVote = h.match(/^vote\/(\d+)\/([^/]+)$/);
  if (proposalSeatVote) {
    return {
      route: "vote-proposal",
      proposalId: Number(proposalSeatVote[1]),
      tokenId: proposalSeatVote[2],
    };
  }
  const proposalVote = h.match(/^vote\/(\d+)$/);
  if (proposalVote) {
    return { route: "vote-proposal", proposalId: Number(proposalVote[1]) };
  }
  if (h === "docs" || h.startsWith("docs/")) return { route: "docs" };
  const map: Record<string, Route> = {
    "": "club",
    club: "club",
    apply: "apply",
    seat: "seat",
    brief: "brief",
    vote: "vote",
    "vote/closed": "vote-closed",
    aireceipt: "aireceipt",
    "ai-receipt": "aireceipt",
    vault: "vault",
    sell: "sell",
    buy: "buy",
    "receipt/vote": "receipt-vote",
    "receipt/sale": "receipt-sale",
    "receipt/buy": "receipt-buy",
    "receipt/vault": "receipt-vault",
    states: "states",
    license: "license",
    policy: "policy",
  };
  return { route: map[h] ?? "club" };
}

export function App() {
  return (
    <WalletProvider>
      <AppContent />
    </WalletProvider>
  );
}

function AppContent() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  let page: JSX.Element;
  switch (route.route) {
    case "seat":
      page = <MySeat />;
      break;
    case "seat-history":
      page = <SeatHistoryPage tokenId={route.tokenId ?? ""} />;
      break;
    case "apply":
      page = <ApplyClaimPage />;
      break;
    case "brief":
      page = <DelegateBrief />;
      break;
    case "vote":
      page = <ProposalVote />;
      break;
    case "vote-proposal":
      page = <ProposalVote proposalId={route.proposalId} tokenId={route.tokenId} />;
      break;
    case "vote-closed":
      page = <ProposalVote closed />;
      break;
    case "aireceipt":
      page = <AIReceiptPage />;
      break;
    case "vault":
      page = <VaultPageFlow />;
      break;
    case "sell":
      page = <SellSeatFlow />;
      break;
    case "buy":
      page = <BuySeatFlow />;
      break;
    case "receipt-vote":
      page = <ReceiptPage kind="vote" />;
      break;
    case "receipt-sale":
      page = <ReceiptPage kind="sale" />;
      break;
    case "receipt-buy":
      page = <ReceiptPage kind="buy" />;
      break;
    case "receipt-vault":
      page = <ReceiptPage kind="vault" />;
      break;
    case "states":
      page = <StatesPage />;
      break;
    case "docs":
      page = <DocsRoute />;
      break;
    case "license":
      page = <LicensePage />;
      break;
    case "policy":
      page = <PolicyPage />;
      break;
    default:
      page = <ClubPage />;
  }

  return (
    <>
      <TestnetStrip />
      <SiteHeader />
      {page}
      <SiteFooter />
    </>
  );
}
