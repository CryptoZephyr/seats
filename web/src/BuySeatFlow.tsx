import { useEffect, useState } from "react";
import { useClubData } from "./chain/useClubData";
import { useViewer } from "./chain/WalletProvider";
import { readSeatNftLevyBps } from "./chain/rpc";
import { saleListings } from "./chain/sales";
import { buildBuyRequest, BUY_SEAT_GAS, calculateSaleSplit } from "./chain/transactions";
import { ErrorStatus, GraphicButton, LoadingStatus, RuledSection, SuccessStatus } from "./ui";
import { checkFunds, friendly, near, PageHead, TxLink, useGasEstimate } from "./flowCommon";
import s from "./screens.module.css";

export function BuySeatFlow() {
  const state = useClubData();
  const viewer = useViewer();
  const [levy, setLevy] = useState<number | null>(null);
  const [busySeatId, setBusySeatId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const gasEstimate = useGasEstimate(BUY_SEAT_GAS);
  useEffect(() => { void readSeatNftLevyBps().then(setLevy).catch(() => setLevy(-1)); }, []);
  if (state.status === "loading") return <main className={s.page}><LoadingStatus>Reading active sale approvals…</LoadingStatus></main>;
  if (state.status === "error") return <main className={s.page}><ErrorStatus onRetry={state.retry}>{state.error.message}</ErrorStatus></main>;
  const now = BigInt(Date.now()) * 1_000_000n;
  const listings = state.data.seats.flatMap((seat) => {
    const approval = seat.record.approval;
    return approval && now < BigInt(approval.expires_at) ? [{ seat, approval }] : [];
  });
  const buy = async (tokenId: string, price: string) => {
    if (!viewer.accountId) return;
    setErrors((previous) => ({ ...previous, [tokenId]: "" }));
    setHashes((previous) => ({ ...previous, [tokenId]: "" }));
    setBusySeatId(tokenId);
    try {
      const request = buildBuyRequest(tokenId, price);
      if (!await checkFunds(viewer.accountId, request)) {
        throw new Error("Your balance is too low for the approved deposit and network fee.");
      }
      const tx = await viewer.callContract(request);
      setHashes((previous) => ({ ...previous, [tokenId]: tx.hash }));
      viewer.retry();
      state.retry();
    } catch (cause) {
      state.retry();
      viewer.retry();
      setErrors((previous) => ({ ...previous, [tokenId]: friendly(cause) }));
    } finally { setBusySeatId(null); }
  };
  return <main className={s.page}>
    <PageHead eyebrow="Seat for sale" title="Seats for sale" />
    {listings.length === 0 ? <RuledSection title="For sale"><p className={s.muted}>No active sale approvals right now.</p></RuledSection>
      : listings.map(({ seat, approval }) => {
        let split: ReturnType<typeof calculateSaleSplit> | null = null;
        try { if (levy === 500) split = calculateSaleSplit(approval.price, levy); } catch { split = null; }
        const namedBuyer = viewer.accountId === approval.buyer;
        return <RuledSection key={seat.token.token_id} title={`Seat ${seat.token.token_id}`}>
          <p className={s.muted}>Reserved for <span className="mono">{approval.buyer}</span></p>
          <p>Deposit: {near(BigInt(approval.price))} NEAR, equal to the seat price.</p>
          <p>Network fee about {gasEstimate ? `${gasEstimate} testnet NEAR` : "checking testnet network fee"}.</p>
          {split ? <p className={s.note}>Seller receives {near(split.seller)} NEAR (95%). Club receives {near(split.club)} NEAR (5%).</p>
            : <p className={s.note}>The live 95/5 split couldn't be verified. Buying is disabled.</p>}
          {!viewer.accountId ? <p className={s.muted}>Sign in as the named buyer to purchase this seat.</p>
            : namedBuyer && split ? <GraphicButton glyph="ticket" disabled={busySeatId !== null} onClick={() => void buy(seat.token.token_id, approval.price)}>Buy for {near(BigInt(approval.price))} NEAR</GraphicButton>
            : <p className={s.muted}>This seat is reserved for {approval.buyer}.</p>}
          {busySeatId === seat.token.token_id && <LoadingStatus>Waiting for your wallet…</LoadingStatus>}
          {errors[seat.token.token_id] && <ErrorStatus>{errors[seat.token.token_id]}</ErrorStatus>}
          {hashes[seat.token.token_id] && <SuccessStatus>Purchase submitted. <TxLink hash={hashes[seat.token.token_id]} /> <a href="#/brief">Save your delegate's brief so it can vote for you.</a></SuccessStatus>}
        </RuledSection>;
      })}
    <RuledSection title="Awaiting club vote">
      {saleListings(state.data.proposals).length === 0 ? <p className={s.muted}>No sale proposals are waiting for a vote.</p>
        : saleListings(state.data.proposals).map((item) =>
          <p key={item.proposal.id}>Seat {item.seatId ?? "unknown"}, proposal {item.proposal.id}: {item.buyerId} at {item.price ? `${near(BigInt(item.price))} NEAR` : "unknown price"}</p>)}
    </RuledSection>
  </main>;
}
