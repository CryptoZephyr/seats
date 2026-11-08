import { useEffect, useState } from "react";
import { useClubData } from "./chain/useClubData";
import { useViewer } from "./chain/WalletProvider";
import { readSeatNftLevyBps, getAccountInfo } from "./chain/rpc";
import {
  buildSaleRequest,
  calculateSaleSplit,
  isTestnetAccountId,
  parseNearAmount,
  PROPOSAL_CALL_GAS,
} from "./chain/transactions";
import { saleListings } from "./chain/sales";
import { ErrorStatus, Fact, GraphicButton, LoadingStatus, RuledSection, SuccessStatus } from "./ui";
import { checkFunds, friendly, near, PageHead, TxLink, useGasEstimate } from "./flowCommon";
import s from "./screens.module.css";

export function SellSeatFlow() {
  const state = useClubData();
  const viewer = useViewer();
  const [buyer, setBuyer] = useState("");
  const [price, setPrice] = useState("");
  const [expiryDays, setExpiryDays] = useState("3");
  const [selectedSeatId, setSelectedSeatId] = useState("");
  const [levy, setLevy] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hash, setHash] = useState("");
  const gasEstimate = useGasEstimate(PROPOSAL_CALL_GAS);
  useEffect(() => { void readSeatNftLevyBps().then(setLevy).catch(() => setLevy(-1)); }, []);
  if (state.status === "loading") return <main className={s.page}><LoadingStatus>Reading testnet sale approvals…</LoadingStatus></main>;
  if (state.status === "error") return <main className={s.page}><ErrorStatus onRetry={state.retry}>{state.error.message}</ErrorStatus></main>;
  if (viewer.accountId && viewer.error) return <main className={s.page}><ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus></main>;
  if (viewer.accountId && viewer.isLoading) return <main className={s.page}><LoadingStatus>Checking your seat on testnet…</LoadingStatus></main>;
  const seats = state.data.seats.filter((seat) => viewer.seatIds.includes(seat.token.token_id));
  const proposals = saleListings(state.data.proposals);
  const selectedSeat = seats.find((seat) => seat.token.token_id === selectedSeatId) ?? seats[0];
  const selectedListing = proposals.find((item) => item.seatId === selectedSeat?.token.token_id);
  const split = (() => {
    try { return price && levy === 500 ? calculateSaleSplit(parseNearAmount(price), levy) : null; }
    catch { return null; }
  })();
  const submit = async () => {
    setError("");
    setHash("");
    if (!viewer.accountId || seats.length === 0) {
      setError("Sign in with the seat holder account to create an offer.");
      return;
    }
    setBusy(true);
    try {
      if (!isTestnetAccountId(buyer)) throw new Error("Enter an existing .testnet buyer account.");
      if (buyer === viewer.accountId) throw new Error("Choose a buyer account other than your own.");
      await getAccountInfo(buyer);
      const amount = parseNearAmount(price);
      calculateSaleSplit(amount, levy ?? -1);
      const seat = selectedSeat;
      if (!seat) throw new Error("Choose a seat before creating an offer.");
      const request = buildSaleRequest(
        seat.token.token_id,
        buyer,
        amount.toString(),
        Number(expiryDays) * 86_400_000_000_000,
        state.data.proposalBond,
      );
      if (!await checkFunds(viewer.accountId, request)) {
        throw new Error("Your balance is too low for the proposal bond and gas.");
      }
      const tx = await viewer.callContract(request);
      setHash(tx.hash);
      state.retry();
    } catch (cause) {
      state.retry();
      viewer.retry();
      setError(friendly(cause));
    } finally { setBusy(false); }
  };

  return <main className={s.page}>
    <PageHead eyebrow="Your seats" title="Sell your seat">
      <p className={s.lede}>The club must approve an offer before the named buyer can purchase.</p>
    </PageHead>
    {!viewer.accountId ? <RuledSection title="Your seat"><p className={s.muted}>Sign in with the seat holder account to create an offer.</p></RuledSection>
      : seats.length === 0 ? <RuledSection title="Your seat"><p className={s.muted}>This account doesn't hold a seat.</p></RuledSection>
      : seats.map((seat) => {
        const listing = proposals.find((item) => item.seatId === seat.token.token_id);
        return <RuledSection key={seat.token.token_id} title={`Seat ${seat.token.token_id}`}>
          {seat.record.approval && <p>Active approval for {seat.record.approval.buyer} at {near(BigInt(seat.record.approval.price))} NEAR.</p>}
          {listing && <dl className={s.facts}>
            <Fact label="Awaiting club vote">Proposal {listing.proposal.id}</Fact>
            <Fact label="Buyer">{listing.buyerId ?? "Unknown"}</Fact>
            <Fact label="Price">{listing.price ? `${near(BigInt(listing.price))} NEAR` : "Unknown"}</Fact>
          </dl>}
        </RuledSection>;
      })}
    {viewer.accountId && seats.length > 0 && <RuledSection title="Create a sale offer">
      {seats.length > 1 && <label className={s.fieldLabel}>Seat
        <select className={s.priceInput} value={selectedSeat?.token.token_id ?? ""} onChange={(event) => setSelectedSeatId(event.target.value)}>
          {seats.map((seat) => <option key={seat.token.token_id} value={seat.token.token_id}>Seat {seat.token.token_id}</option>)}
        </select>
      </label>}
      {selectedSeat?.record.approval && <p className={s.note}>If the club approves this offer, it replaces the current approval for {selectedSeat.record.approval.buyer}.</p>}
      {selectedListing ? <p className={s.note}>A sale offer for this seat is already in the club vote.</p> : <>
      <label className={s.fieldLabel}>Buyer's .testnet account
        <input className={s.priceInput} value={buyer} onChange={(event) => setBuyer(event.target.value)} />
      </label>
      <label className={s.fieldLabel}>Price in NEAR
        <input className={s.priceInput} inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
      </label>
      <label className={s.fieldLabel}>Buyer has {expiryDays} {expiryDays === "1" ? "day" : "days"} after club approval to buy
        <select className={s.priceInput} value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}>
          <option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option>
        </select>
      </label>
      {split ? <p className={s.note}>Seller receives {near(split.seller)} NEAR (95%). Club receives {near(split.club)} NEAR (5%).</p>
        : <p className={s.note}>The sale split is unavailable until the live contract levy is verified as 500 bps.</p>}
      <p>Proposal bond: {near(BigInt(state.data.proposalBond))} NEAR, returned on decision. Estimated gas: {gasEstimate ? `${gasEstimate} NEAR` : "checking testnet gas price"}.</p>
      <GraphicButton glyph="ticket" onClick={() => void submit()} disabled={busy || levy !== 500 || !split}>Submit sale for club vote</GraphicButton>
      {busy && <LoadingStatus>Waiting for your wallet…</LoadingStatus>}
      {error && <ErrorStatus>{error}</ErrorStatus>}
      {hash && <SuccessStatus>Sale proposal submitted. <TxLink hash={hash} /></SuccessStatus>}
      </>}
    </RuledSection>}
  </main>;
}
