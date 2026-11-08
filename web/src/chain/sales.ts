import type { ProposalView } from "./types";
import { chainConfig } from "./config";

export interface SaleProposalListing {
  proposal: ProposalView;
  seatId: string | null;
  buyerId: string | null;
  price: string | null;
}

function saleArgs(args: string): Pick<SaleProposalListing, "seatId" | "buyerId" | "price"> {
  try {
    const bytes = Uint8Array.from(atob(args), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return {
      seatId: typeof value.token_id === "string" ? value.token_id : null,
      buyerId: typeof value.buyer === "string" ? value.buyer : null,
      price: typeof value.price === "string" && /^\d+$/.test(value.price) ? value.price : null,
    };
  } catch {
    return { seatId: null, buyerId: null, price: null };
  }
}

export function saleListings(proposals: ProposalView[]): SaleProposalListing[] {
  return proposals.flatMap((proposal) => {
    if (
      proposal.status !== "InProgress" ||
      typeof proposal.kind !== "object" ||
      proposal.kind === null ||
      !("FunctionCall" in proposal.kind)
    ) return [];
    const call = proposal.kind.FunctionCall;
    if (call.receiver_id !== chainConfig.seatNftAccountId) return [];
    return call.actions
      .filter((action) => action.method_name === "approve_sale")
      .map((action) => ({ proposal, ...saleArgs(action.args) }));
  });
}
