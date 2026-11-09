import { useEffect, useState, type JSX } from "react";
import { chainConfig } from "./chain/config";
import {
  isCurrentVoteOverridden,
  latestMemberChange,
  originalDelegateVote,
  type MemberChangeHistory,
} from "./chain/history";
import type { SeatSnapshot } from "./chain/club";
import { callView, readSeatNftLevyBps } from "./chain/rpc";
import {
  calculateSaleSplit,
  contractErrorCode,
  explorerTxUrl,
  friendlyVoteError,
} from "./chain/transactions";
import { useClubData } from "./chain/useClubData";
import { useViewer } from "./chain/WalletProvider";
import type { PendingView, ProposalView, VoteResult } from "./chain/types";
import { formatProposalDate } from "./proposalDate";
import { isProposalVotingClosed, newestFirst } from "./proposals";
import { saleListings } from "./chain/sales";
import { buildBriefMessage, buildBriefRelayUrl, buildBriefRequestBody, hashBrief, randomBriefSalt } from "./chain/brief";
import { SET_BRIEF_GAS } from "./chain/transactions";
import {
  loadPendingBriefSave,
  pendingBriefSessionStorage,
  storePendingBriefSave,
  submitPendingBriefSave,
} from "./chain/pendingBrief";
import { friendly, useGasEstimate } from "./flowCommon";
import { PendingBriefSaveButton } from "./PendingBriefSaveButton";
import { SeatPlan, VoteMark, type VoteKind } from "./seatplan";
import { canChangePendingVote, changeAttribution } from "./voteControls";
import { useMockRun } from "./useMockRun";
import { SeatArtwork } from "./SeatArtwork";
import {
  CastStatus,
  CastRetryStatus,
  CheckedStamp,
  CastingStatus,
  ErrorStatus,
  LoadingStatus,
  HashValue,
  MoneySplit,
  SuccessStatus,
  Fact,
  GraphicButton,
  OverriddenStatus,
  PendingStatus,
  ReceiptSteps,
  RefusedStamp,
  ResultStamp,
  RuledSection,
  StepStatus,
  TextButton,
  VotingClosedStatus,
  WindowClosedStatus,
  WindowBar,
} from "./ui";
import s from "./screens.module.css";

type ClubDataState = ReturnType<typeof useClubData>;

function ReadPageState({
  state,
  retry,
  keepCurrentPage = false,
}: {
  state: ClubDataState;
  retry: () => void;
  keepCurrentPage?: boolean;
}) {
  if (keepCurrentPage) return null;
  if (state.status === "ready") return null;
  return (
    <main className={s.page}>
      {state.status === "loading" ? (
        <LoadingStatus>Reading NEAR testnet views…</LoadingStatus>
      ) : (
        <ErrorStatus onRetry={retry}>{state.error.message}</ErrorStatus>
      )}
    </main>
  );
}

type SeatVoteState =
  | {
      kind: "pending";
      pending: PendingView;
      sublabel?: "casting" | "retry" | "windowClosed";
    }
  | { kind: "missed"; pending: PendingView }
  | { kind: "cast"; result: VoteResult }
  | { kind: "closed"; result: VoteResult }
  | { kind: "none"; votingClosed: boolean };

function seatVoteState(
  seat: SeatSnapshot,
  proposalId: number,
  votingClosed: boolean,
  nowNs: bigint,
): SeatVoteState {
  const pending = seat.pending[proposalId];
  const result = seat.results.results.findLast((item) => item.proposal_id === proposalId);

  if (result?.cast) return { kind: "cast", result };
  if (pending) {
    if (votingClosed) return { kind: "missed", pending };
    const uncastResult = result && !result.cast ? result : undefined;
    const sublabel =
      pending.casting || uncastResult?.status === "Casting"
        ? "casting"
        : uncastResult?.status === "Failed"
          ? "retry"
          : BigInt(pending.deadline) <= nowNs
            ? "windowClosed"
            : undefined;
    return { kind: "pending", pending, sublabel };
  }
  if (result) return { kind: "closed", result };
  return { kind: "none", votingClosed };
}

function proposalKindName(proposal: ProposalView): string {
  if (typeof proposal.kind === "string") return proposal.kind;
  const name = Object.keys(proposal.kind)[0] ?? "Unknown";
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function ProposalDate({ timestampNs }: { timestampNs: string }) {
  const formatted = formatProposalDate(timestampNs);
  return (
    <time dateTime={formatted.datetime} title={formatted.tooltip}>
      {formatted.text}
    </time>
  );
}

function ProposalDeadline({ deadlineNs }: { deadlineNs: bigint }) {
  const deadlineMs = Number(deadlineNs / 1_000_000n);
  const formatted = formatProposalDate(deadlineNs);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.floor((deadlineMs - now) / 1000));
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <PendingStatus
      deadline={formatted.time}
      countdown={countdown}
      title={formatted.tooltip}
    />
  );
}

function InProgressProposalStatus({
  proposal,
  periodNs,
}: {
  proposal: ProposalView;
  periodNs: string;
}) {
  const deadlineNs = BigInt(proposal.submission_time) + BigInt(periodNs);
  const deadlineMs = Number(deadlineNs / 1_000_000n);
  const formatted = formatProposalDate(deadlineNs);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (isProposalVotingClosed(proposal, periodNs, BigInt(now) * 1_000_000n)) {
    return <VotingClosedStatus />;
  }

  const remaining = Math.max(0, Math.floor((deadlineMs - now) / 1000));
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <PendingStatus
      deadline={formatted.time}
      countdown={countdown}
      title={formatted.tooltip}
    />
  );
}

function ProposalStatus({
  proposal,
  periodNs,
}: {
  proposal: ProposalView;
  periodNs: string;
}) {
  if (proposal.status === "InProgress") {
    return <InProgressProposalStatus proposal={proposal} periodNs={periodNs} />;
  }
  return <ResultStamp result={proposal.status} />;
}

function latestVote(seat: SeatSnapshot): { kind: VoteKind; vote: string; proposalId: number } | undefined {
  const latest = seat.results.results.findLast((result) => result.cast);
  if (latest?.vote === "Approve") return { kind: "tick", vote: latest.vote, proposalId: latest.proposal_id };
  if (latest?.vote === "Reject") return { kind: "cross", vote: latest.vote, proposalId: latest.proposal_id };
  if (latest?.vote === "Abstain") return { kind: "ring", vote: latest.vote, proposalId: latest.proposal_id };
  return undefined;
}

function voteSourceLabel(source: string): string {
  if (source === "pending") return "Pending vote";
  if (source === "controller") return "Seat controller";
  return source;
}

function activeSaleApprovals(seats: SeatSnapshot[], nowNs: bigint) {
  return seats.flatMap((seat) => {
    const approval = seat.record.approval;
    if (!approval || nowNs >= BigInt(approval.expires_at)) return [];
    return [{
      seatId: seat.token.token_id,
      sellerId: seat.token.owner_id,
      buyerId: approval.buyer,
      price: approval.price,
      expiresAt: String(approval.expires_at),
    }];
  });
}

function useCurrentTimeNs() {
  const [nowNs, setNowNs] = useState(() => BigInt(Date.now()) * 1_000_000n);
  useEffect(() => {
    const timer = window.setInterval(
      () => setNowNs(BigInt(Date.now()) * 1_000_000n),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return nowNs;
}

function SaleApprovalDetails({
  listing,
}: {
  listing: ReturnType<typeof activeSaleApprovals>[number];
}) {
  const [levyBps, setLevyBps] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void readSeatNftLevyBps().then(
      (value) => { if (active) setLevyBps(value); },
      () => { if (active) setLevyBps(-1); },
    );
    return () => { active = false; };
  }, []);
  let split: { seller: bigint; club: bigint } | null = null;
  try {
    if (levyBps === 500) split = calculateSaleSplit(listing.price, levyBps);
  } catch {
    split = null;
  }
  return (
    <dl className={s.facts}>
      <Fact label="Buyer"><span className="mono">{listing.buyerId}</span></Fact>
      <Fact label="Price and split">
        {split ? <MoneySplit
          price={nearAmount(listing.price)}
          sellerPct={nearAmount(split.seller.toString())}
          levyPct={nearAmount(split.club.toString())}
        /> : <span className={s.muted}>Sale split unavailable until the live levy is verified.</span>}
      </Fact>
      <Fact label="Approval expires">
        <ProposalDate timestampNs={listing.expiresAt} />
      </Fact>
    </dl>
  );
}

function nearAmount(yocto: string): string {
  const amount = BigInt(yocto);
  const whole = amount / 10n ** 24n;
  const fraction = (amount % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function ClubPage() {
  const state = useClubData();
  const viewer = useViewer();
  const nowNs = useCurrentTimeNs();
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const { data } = state;
  const clubName = data.config.name.trim() || chainConfig.daoAccountId;
  const saleApprovals = activeSaleApprovals(data.seats, nowNs);
  const saleProposals = saleListings(data.proposals, data.proposalPeriodNs, nowNs);
  const seats = data.seats.map((seat) => ({
    seat: seat.token.token_id,
    ownerId: seat.token.owner_id,
    artwork: seat.token.metadata?.media,
    lastVote: latestVote(seat),
  }));
  const hasMine = Boolean(viewer.accountId && seats.some((seat) => seat.ownerId === viewer.accountId));
  const voteKinds = new Set(seats.map((seat) => seat.lastVote?.kind).filter(Boolean));

  return (
    <main className={`${s.page} ${s.pageWide}`}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>A Sputnik DAO club</p>
        <h1>{clubName}</h1>
        <p className={s.muted}>
          <small className="mono">{chainConfig.daoAccountId}</small>
        </p>
        <p className={s.lede}>
          Each seat carries one vote in the club's DAO and opens the club vault. Seats move only
          through a club-approved sale.
        </p>
        <p><TextButton href="#/apply">Apply for a seat</TextButton></p>
      </header>

      <RuledSection
        title="The seat plan"
        aside={
          <span className={s.muted}>
            {data.tokens.length} {data.tokens.length === 1 ? "seat" : "seats"} held
          </span>
        }
        inset
      >
        {seats.length === 0 ? (
          <p className={s.muted}>No seats have been minted yet.</p>
        ) : (
          <>
            <SeatPlan seats={seats} viewerAccountId={viewer.accountId} />
            <div className={s.seatHistoryLinks}>
              {seats.map((seat) => (
                <div className={s.seatHistoryEntry} key={seat.seat}>
                  <SeatArtwork seatId={seat.seat} media={seat.artwork} />
                  <span>
                    <strong>Seat {seat.seat}</strong>
                    <span className={s.muted}> · held by <span className="mono">{seat.ownerId}</span></span>
                  </span>
                  <TextButton href={`#/seat/${seat.seat}/history`}>View history</TextButton>
                </div>
              ))}
            </div>
            <p className={s.legend}>
              <span><i className={`${s.swatch} ${s.swatchHeld}`} /> Held</span>
              {hasMine && <span><i className={`${s.swatch} ${s.swatchMine}`} /> Yours</span>}
              {voteKinds.has("tick") && <span><VoteMark kind="tick" size={14} /> Approve</span>}
              {voteKinds.has("cross") && <span><VoteMark kind="cross" size={14} /> Reject</span>}
              {voteKinds.has("ring") && <span><VoteMark kind="ring" size={14} /> Abstain</span>}
            </p>
          </>
        )}
        {viewer.accountId && viewer.isLoading && <LoadingStatus>Checking this account's seats…</LoadingStatus>}
        {viewer.error && <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>}
      </RuledSection>

      <RuledSection title="What a seat gives">
        <ul className={s.gives}>
          <li>One vote in the club's Sputnik DAO</li>
          <li>Access to the club vault</li>
          <li>Your delegate votes from your private brief</li>
        </ul>
      </RuledSection>

      <RuledSection title="DAO proposals">
        {data.proposals.length === 0 ? (
          <p className={s.muted}>No proposals have been submitted.</p>
        ) : (
          <ul className={s.decisions}>
            {newestFirst(data.proposals).map((proposal) => (
              <li key={proposal.id} className={s.decision}>
                <div className={s.decisionMain}>
                  <span className={s.decisionTitle}>
                    Proposal {proposal.id}: {proposal.description}
                  </span>
                  <span className={s.decisionDetail}>
                    Proposed by <span className="mono">{proposal.proposer}</span> · {proposalKindName(proposal)}
                  </span>
                  <span className={s.decisionTime}>
                    Submitted <ProposalDate timestampNs={proposal.submission_time} />
                  </span>
                </div>
                <div className={s.decisionSide}>
                  <ProposalStatus proposal={proposal} periodNs={data.proposalPeriodNs} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>

      <RuledSection
        title="For sale"
        aside={
          saleApprovals.length > 0 ? (
            <TextButton href="#/buy">Review sale</TextButton>
          ) : undefined
        }
      >
        {saleApprovals.length === 0 ? (
          <p className={s.muted}>No seats are listed right now.</p>
        ) : (
          <ul className={s.listings}>
            {saleApprovals.map((listing) => (
              <li key={listing.seatId} className={s.listing}>
                <div>
                  <strong>Seat {listing.seatId}</strong>
                  <span className={s.muted}> · held by <span className="mono">{listing.sellerId}</span></span>
                </div>
                <SaleApprovalDetails listing={listing} />
              </li>
            ))}
          </ul>
        )}
      </RuledSection>

      <RuledSection title="Awaiting club vote">
        {saleProposals.length === 0 ? (
          <p className={s.muted}>No seat sales are waiting for a club vote.</p>
        ) : (
          <ul className={s.listings}>
            {saleProposals.map((listing) => (
              <li key={listing.proposal.id} className={s.listing}>
                <div>
                  <strong>
                    {listing.seatId ? `Seat ${listing.seatId}` : `Proposal ${listing.proposal.id}`}
                  </strong>
                  <span className={s.muted}> · Proposal {listing.proposal.id}</span>
                </div>
                <dl className={s.facts}>
                  {listing.buyerId && (
                    <Fact label="Buyer"><span className="mono">{listing.buyerId}</span></Fact>
                  )}
                  {listing.price && <Fact label="Price">{nearAmount(listing.price)} NEAR</Fact>}
                  <Fact label="Status">
                    <ProposalStatus proposal={listing.proposal} periodNs={data.proposalPeriodNs} />
                  </Fact>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>
    </main>
  );
}

export function MySeat() {
  const state = useClubData();
  const viewer = useViewer();
  const nowNs = useCurrentTimeNs();
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const { data } = state;
  const owned = data.seats.filter((seat) => viewer.seatIds.includes(seat.token.token_id));

  if (viewer.accountId && viewer.isLoading) {
    return (
      <main className={s.page}>
        <header className={s.pageHead}>
          <p className={s.eyebrow}>Your seat</p>
          <h1>Your seat</h1>
        </header>
        <LoadingStatus>Checking this account's seats…</LoadingStatus>
      </main>
    );
  }

  if (viewer.accountId && viewer.error) {
    return (
      <main className={s.page}>
        <header className={s.pageHead}>
          <p className={s.eyebrow}>Your seat</p>
          <h1>Your seat</h1>
        </header>
        <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
      </main>
    );
  }

  if (!viewer.accountId) {
    return (
      <main className={s.page}>
        <header className={s.pageHead}>
          <p className={s.eyebrow}>Your seat</p>
          <h1>Your seat</h1>
          <p className={s.lede}>Sign in to see your seat, your delegate, and proposals for your vote.</p>
        </header>
        <RuledSection>
          <GraphicButton
            glyph="seat"
            onClick={viewer.signIn}
            disabled={!viewer.walletReady}
          >
            Sign in
          </GraphicButton>
          {viewer.error && <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>}
          <p className={s.note}>A seat gives you one vote in the club and access to its vault.</p>
        </RuledSection>
      </main>
    );
  }

  if (owned.length === 0) {
    return (
      <main className={s.page}>
        <header className={s.pageHead}>
          <p className={s.eyebrow}>Your seat</p>
          <h1>Your seat</h1>
        </header>
        <RuledSection title="Your seat">
          <p className={s.muted}>You don't hold a seat with this account.</p>
          <TextButton href="#/club">View the club</TextButton>
        </RuledSection>
      </main>
    );
  }

  const openVotes = owned.flatMap((seat) =>
    newestFirst(
      data.proposals.filter(
        (proposal) =>
          proposal.status === "InProgress" &&
          !isProposalVotingClosed(proposal, data.proposalPeriodNs, nowNs),
      ),
    ).map((proposal) => ({
      seat,
      proposal,
      voteState: seatVoteState(
        seat,
        proposal.id,
        proposal.status !== "InProgress" ||
          isProposalVotingClosed(proposal, data.proposalPeriodNs, nowNs),
        nowNs,
      ),
    })),
  );

  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Your seat</p>
        <h1>{owned.length === 1 ? `Seat ${owned[0].token.token_id}` : "Your seats"}</h1>
      </header>

      <RuledSection title="Your delegate">
        <dl className={s.facts}>
          {owned.map((seat) => (
            <div key={seat.token.token_id}>
              <Fact label={`Seat ${seat.token.token_id} artwork`}>
                <SeatArtwork seatId={seat.token.token_id} media={seat.token.metadata?.media} />
              </Fact>
              <Fact label={`Seat ${seat.token.token_id} delegate`}>
                <span className="mono">{seat.record.voter_id}</span>
              </Fact>
              <Fact label="Controller">
                <span className="mono">{seat.controller}</span>
              </Fact>
              <Fact label="Brief fingerprint">
                {seat.briefHash ? (
                  <HashValue value={seat.briefHash} label="brief fingerprint" />
                ) : "No fingerprint stored"}
              </Fact>
              <Fact label={`Seat ${seat.token.token_id} history`}>
                <TextButton href={`#/seat/${seat.token.token_id}/history`}>View seat history</TextButton>
              </Fact>
            </div>
          ))}
        </dl>
        <div className={s.actions}>
          <TextButton href="#/sell">Sell this seat</TextButton>
          <TextButton href="#/vault">Open the club vault</TextButton>
          <TextButton href="#/brief">Edit your delegate's brief</TextButton>
        </div>
      </RuledSection>

      <RuledSection title="Open proposals">
        {openVotes.length === 0 ? (
          <p className={s.muted}>No open proposals right now</p>
        ) : (
          <ul className={s.proposals}>
            {openVotes.map(({ seat, proposal, voteState }) => (
              <li key={`${seat.token.token_id}-${proposal.id}`} className={s.proposal}>
                <div>
                  <span className={s.proposalTitle}>
                    Proposal {proposal.id}: {proposal.description}
                  </span>
                  <span className={s.decisionTime}>
                    Seat {seat.token.token_id} · submitted{" "}
                    <ProposalDate timestampNs={proposal.submission_time} />
                  </span>
                  <dl className={s.facts}>
                    {voteState.kind === "pending" ? (
                      <>
                        <Fact label="Your delegate's vote">{voteState.pending.vote}</Fact>
                        {voteState.sublabel === "casting" && (
                          <Fact label="Cast status"><CastingStatus /></Fact>
                        )}
                        {voteState.sublabel === "retry" && (
                          <Fact label="Cast status"><CastRetryStatus /></Fact>
                        )}
                        {voteState.sublabel === "windowClosed" && (
                          <>
                            <Fact label="Cast status"><WindowClosedStatus /></Fact>
                            <Fact label="Override window">
                              Closed at{" "}
                              <ProposalDate timestampNs={voteState.pending.deadline} />
                            </Fact>
                          </>
                        )}
                      </>
                    ) : voteState.kind === "missed" ? (
                      <Fact label="Vote status">
                        <VotingClosedStatus />{" "}
                        Your delegate chose {voteState.pending.vote}, but it wasn't cast in time
                      </Fact>
                    ) : voteState.kind === "cast" ? (
                      <Fact label="Vote">
                        Your seat voted {voteState.result.vote} <CastStatus />
                      </Fact>
                    ) : voteState.kind === "closed" ? (
                      <Fact label="Voter status">
                        <RefusedStamp>{voteState.result.status}</RefusedStamp>
                      </Fact>
                    ) : voteState.votingClosed ? (
                      <Fact label="Vote status">
                        <VotingClosedStatus /> No vote from this seat
                      </Fact>
                    ) : (
                      <Fact label="Vote status">Your delegate hasn't voted yet</Fact>
                    )}
                  </dl>
                  {voteState.kind === "pending" && voteState.sublabel !== "windowClosed" && (
                    <ProposalDeadline
                      deadlineNs={BigInt(voteState.pending.deadline)}
                    />
                  )}
                  {voteState.kind === "none" && !voteState.votingClosed && (
                    <ProposalDeadline
                      deadlineNs={
                        BigInt(proposal.submission_time) + BigInt(data.proposalPeriodNs)
                      }
                    />
                  )}
                </div>
                <TextButton
                  href={`#/vote/${proposal.id}/${encodeURIComponent(seat.token.token_id)}`}
                >
                  Review vote
                </TextButton>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>
    </main>
  );
}

export function DelegateBrief() {
  const state = useClubData();
  const viewer = useViewer();
  const gasEstimate = useGasEstimate(SET_BRIEF_GAS);
  const [brief, setBrief] = useState("");
  const [pendingBrief, setPendingBrief] = useState(() =>
    loadPendingBriefSave(pendingBriefSessionStorage()),
  );
  const [selectedSeatId, setSelectedSeatId] = useState(() => pendingBrief?.seatId ?? "");
  const [step, setStep] = useState(() => pendingBrief ? 3 : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [txHash, setTxHash] = useState("");
  useEffect(() => {
    const restored = loadPendingBriefSave(pendingBriefSessionStorage(), viewer.accountId);
    setBrief("");
    setPendingBrief(restored);
    setSelectedSeatId(restored?.seatId ?? "");
    setStep(restored ? 3 : 0);
    setError("");
    setReadError("");
    setTxHash("");
  }, [viewer.accountId]);
  const keepCurrentPage = Boolean(pendingBrief) || step === 4;
  const pageState = ReadPageState({ state, retry: state.retry, keepCurrentPage });
  if (pageState) return pageState;
  if (state.status !== "ready" && !keepCurrentPage) return null;

  const seats = state.status === "ready"
    ? state.data.seats.filter((seat) => viewer.seatIds.includes(seat.token.token_id))
    : [];
  const selectedSeat = seats.find((seat) => seat.token.token_id === selectedSeatId) ?? seats[0];
  const refreshClubData = async () => {
    setReadError("");
    try {
      await state.refresh();
    } catch (cause) {
      setReadError(friendly(cause));
    }
  };
  const postBrief = async () => {
    if (!viewer.accountId || !selectedSeat) return;
    setError("");
    setTxHash("");
    setBusy(true);
    setStep(1);
    let relayStored = false;
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const salt = randomBriefSalt();
      const hash = await hashBrief(salt, brief);
      const message = buildBriefMessage(selectedSeat.token.token_id, hash, Date.now());
      const signed = await viewer.signMessage(message, nonce, "seats-agent-runner");
      setStep(2);
      const response = await fetch(buildBriefRelayUrl(chainConfig.runnerUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBriefRequestBody(
          signed.accountId,
          signed.publicKey,
          signed.signature,
          nonce,
          message,
          brief,
          salt,
        )),
      });
      const result = await response.json() as {
        secrets_account_id?: string;
        profile?: string;
        brief_hash?: string;
        tx_hash?: string;
        already_stored?: boolean;
        error?: string;
      };
      if (
        !response.ok
        || !result.secrets_account_id
        || !result.profile
        || !result.brief_hash
        || (!result.tx_hash && result.already_stored !== true)
      ) {
        throw new Error(result.error ? briefRelayError(result.error) : "The private brief couldn't be stored.");
      }
      relayStored = true;
      const pending = {
        voterId: selectedSeat.record.voter_id,
        seatId: selectedSeat.token.token_id,
        ownerAccountId: viewer.accountId,
        result: {
          secrets_account_id: result.secrets_account_id,
          profile: result.profile,
          brief_hash: result.brief_hash,
        },
      };
      setPendingBrief(pending);
      setSelectedSeatId(pending.seatId);
      setStep(3);
      storePendingBriefSave(pendingBriefSessionStorage(), pending);
    } catch (cause) {
      setError(friendly(cause));
      if (!relayStored) setStep(0);
    } finally {
      setBusy(false);
    }
  };
  const saveFingerprint = async () => {
    if (!pendingBrief || !viewer.accountId) return;
    setBusy(true);
    setStep(5);
    setError("");
    try {
      const tx = await submitPendingBriefSave(
        pendingBrief,
        viewer.callContract,
        pendingBriefSessionStorage(),
      );
      setTxHash(tx.hash);
      setPendingBrief(null);
      setStep(4);
      setError("");
      void refreshClubData();
    } catch (cause) {
      setError(friendly(cause));
      setStep(3);
    } finally {
      setBusy(false);
    }
  };
  const resetBrief = () => {
    setBrief("");
    setPendingBrief(null);
    setStep(0);
    setError("");
    setReadError("");
    setTxHash("");
  };
  const readFailure = readError || (state.status === "error" ? state.error.message : "");
  const stepStatuses = (
    <ol className={s.gives}>
      <li>1. Confirm in your wallet that you hold this seat (no fee) <StepStatus status={step === 1 ? "Pending" : step > 1 ? "Complete" : "Waiting"} /></li>
      <li>2. Storing your brief privately <StepStatus status={step === 2 ? "Pending" : step >= 3 ? "Complete" : "Waiting"} /> <span className={s.muted}>can take up to a minute if the service was asleep</span></li>
      <li>3. Save the fingerprint on-chain <StepStatus status={step === 5 ? "Pending" : step === 4 ? "Complete" : "Waiting"} /> <span className={s.muted}>Network fee about {gasEstimate ? `${gasEstimate} testnet NEAR` : "checking testnet network fee"}. Storage: 0.1 NEAR.</span></li>
    </ol>
  );

  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>{viewer.seatIds.length === 1 ? `Seat ${viewer.seatIds[0]}` : "Your seat"}</p>
        <h1>Your delegate's brief</h1>
        <p className={s.lede}>
          Your delegate reads each proposal and prepares a vote from this brief. You can override
          any vote before it is cast.
        </p>
      </header>

      <RuledSection title="The brief">
        {pendingBrief ? (
          <>
            {viewer.isLoading && <LoadingStatus>Checking this account's seats…</LoadingStatus>}
            {viewer.error && <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>}
            {readFailure && <ErrorStatus onRetry={() => void refreshClubData()}>{readFailure}</ErrorStatus>}
            {stepStatuses}
            <PendingBriefSaveButton
              onClick={() => void saveFingerprint()}
              disabled={busy || !viewer.accountId || !viewer.walletReady}
            />
            {busy && <LoadingStatus>Saving the fingerprint on-chain…</LoadingStatus>}
            {error && <ErrorStatus>{error}</ErrorStatus>}
          </>
        ) : step === 4 && state.status !== "ready" ? (
          <>
            {readFailure && <ErrorStatus onRetry={() => void refreshClubData()}>{readFailure}</ErrorStatus>}
            {stepStatuses}
            <SuccessStatus>Your delegate uses this brief from the next proposal. <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">View transaction</a></SuccessStatus>
            <GraphicButton glyph="keys" onClick={resetBrief}>Write a new brief</GraphicButton>
          </>
        ) : !viewer.accountId ? (
          <p className={s.muted}>Sign in with the wallet that holds your seat to save a private brief.</p>
        ) : viewer.isLoading ? (
          <LoadingStatus>Checking this account's seats…</LoadingStatus>
        ) : viewer.error ? (
          <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
        ) : seats.length > 0 ? (
          <>
            {seats.length > 1 && <label className={s.fieldLabel}>Seat
              <select className={s.priceInput} value={selectedSeat?.token.token_id ?? ""} onChange={(event) => {
                setSelectedSeatId(event.target.value);
                setBrief("");
                setPendingBrief(null);
                setStep(0);
                setError("");
              }}>
                {seats.map((seat) => <option key={seat.token.token_id} value={seat.token.token_id}>Seat {seat.token.token_id}</option>)}
              </select>
            </label>}
            {selectedSeat?.briefHash ? <p>Current fingerprint: <HashValue value={selectedSeat.briefHash} label="brief fingerprint" /></p>
              : <p>Your delegate can't vote until you save a brief.</p>}
            <p className={s.note}>Your current brief isn't shown because it's stored privately. Saving replaces it.</p>
            <p className={s.note}>Your brief is sent over HTTPS to the Seats runner, which doesn't keep it, and to OutLayer's keystore, which encrypts it. Only the fingerprint and a profile reference go on-chain.</p>
            <label className={s.fieldLabel}>Your delegate's brief
              <textarea className={s.briefInput} rows={8} maxLength={4000} value={brief} onChange={(event) => setBrief(event.target.value)} />
            </label>
            <p className={s.note}>{brief.length}/4000 characters</p>
            {step === 4 && readError && <ErrorStatus onRetry={() => void refreshClubData()}>{readError}</ErrorStatus>}
            {stepStatuses}
            {step < 4 ? <GraphicButton glyph="keys" onClick={() => void postBrief()} disabled={busy || !brief.trim() || brief.length > 4000}>
              Save private brief
            </GraphicButton> : step === 4 ? <GraphicButton glyph="keys" onClick={resetBrief} disabled={busy}>
              Write a new brief
            </GraphicButton> : null}
            {busy && <LoadingStatus>{step <= 1 ? "Waiting for your wallet…" : step === 2 ? "Storing your brief privately…" : "Saving the fingerprint on-chain…"}</LoadingStatus>}
            {error && <ErrorStatus>{error}</ErrorStatus>}
            {step === 4 && <SuccessStatus>Your delegate uses this brief from the next proposal. <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer">View transaction</a></SuccessStatus>}
          </>
        ) : (
          <>
            <p><StepStatus status="Retry" /> This account doesn't show a seat yet.</p>
            <GraphicButton glyph="seat" onClick={viewer.retry}>Check again</GraphicButton>
          </>
        )}
      </RuledSection>

      <RuledSection title="What the delegate can and cannot do">
        <ul className={s.gives}>
          <li>It can prepare a vote on each open proposal.</li>
          <li>It cannot cast early, override your decision, or move funds.</li>
          <li>Its key is limited to requesting votes, nothing else.</li>
        </ul>
      </RuledSection>
    </main>
  );
}

function briefRelayError(code: string): string {
  switch (code) {
    case "FULL_ACCESS_REQUIRED":
      return "Use a full-access key for this NEAR testnet account.";
    case "INVALID_SIGNATURE":
      return "The wallet signature couldn't be verified. Try saving again.";
    case "MESSAGE_EXPIRED":
    case "NONCE_REUSED":
      return "The wallet confirmation expired. Try saving again.";
    case "NOT_TOKEN_OWNER":
      return "This wallet no longer owns the selected seat.";
    case "NOT_VOTER_CONTROLLER":
      return "This wallet no longer controls the selected seat's delegate.";
    case "INVALID_SALT":
    case "INVALID_BRIEF":
    case "BRIEF_HASH_MISMATCH":
      return "The brief couldn't be verified. Review it and try again.";
    case "RATE_LIMITED":
      return "Too many brief saves were requested. Wait before trying again.";
    case "BRIEF_OWNER_LOW_BALANCE":
    case "PROFILE_STORE_FAILED":
      return "Private storage is temporarily unavailable. Try again later.";
    default:
      return "The private brief couldn't be stored. Try again.";
  }
}

type VoteChange =
  | { method: "override_vote"; vote: "Approve" | "Reject" }
  | { method: "cancel" };

type ChangeHistoryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; change: MemberChangeHistory | null };

type VoteActionState =
  | { status: "idle" }
  | { status: "waiting" }
  | { status: "success"; change: VoteChange; txHash: string | null }
  | { status: "error"; message: string };

function ProposalVoteMember({
  state,
  viewer,
  proposal,
  seat,
  voteState,
  tokenId,
}: {
  state: Extract<ClubDataState, { status: "ready" }>;
  viewer: ReturnType<typeof useViewer>;
  proposal: ProposalView;
  seat?: SeatSnapshot;
  voteState?: SeatVoteState;
  tokenId?: string;
}) {
  const networkFee = useGasEstimate(SET_BRIEF_GAS);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [historyState, setHistoryState] = useState<ChangeHistoryState>({ status: "loading" });
  const [actionState, setActionState] = useState<VoteActionState>({ status: "idle" });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [closedPending, setClosedPending] = useState<PendingView | null | undefined>(undefined);
  const voterId = seat?.record.voter_id;

  useEffect(() => {
    let active = true;
    if (!voterId) {
      setHistoryState({ status: "ready", change: null });
      return () => {
        active = false;
      };
    }

    setHistoryState({ status: "loading" });
    latestMemberChange(voterId, proposal.id)
      .then((change) => {
        if (active) setHistoryState({ status: "ready", change });
      })
      .catch(() => {
        if (active) setHistoryState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [voterId, proposal.id, historyAttempt]);

  useEffect(() => {
    let active = true;
    if (!seat || proposal.status === "InProgress") {
      setClosedPending(undefined);
      return () => { active = false; };
    }
    setClosedPending(undefined);
    callView(seat.record.voter_id, "get_pending", { proposal_id: proposal.id })
      .then((pending) => {
        if (active) setClosedPending(pending);
      })
      .catch(() => {
        if (active) setClosedPending(null);
      });
    return () => { active = false; };
  }, [seat?.record.voter_id, seat?.token.token_id, proposal.id, proposal.status]);

  useEffect(() => {
    setActionState({ status: "idle" });
    setConfirmCancel(false);
    setRefreshFailed(false);
  }, [proposal.id, seat?.token.token_id]);

  async function refreshAfterChange() {
    try {
      await state.refresh();
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    }
    setHistoryAttempt((value) => value + 1);
  }

  async function retrySnapshotRefresh() {
    try {
      await state.refresh();
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    }
  }

  async function submitChange(change: VoteChange) {
    if (!seat) return;
    setIsSubmitting(true);
    setActionState({ status: "waiting" });
    setConfirmCancel(false);
    setRefreshFailed(false);

    try {
      const txHash = change.method === "override_vote"
        ? await viewer.callVoter(seat.record.voter_id, "override_vote", {
            proposal_id: proposal.id,
            vote: change.vote,
          })
        : await viewer.callVoter(seat.record.voter_id, "cancel", {
            proposal_id: proposal.id,
          });
      setActionState({ status: "success", change, txHash });
      await refreshAfterChange();
    } catch (error) {
      const code = contractErrorCode(error);
      if (!code) {
        try {
          const [pending, results] = await Promise.all([
            callView(seat.record.voter_id, "get_pending", { proposal_id: proposal.id }),
            callView(seat.record.voter_id, "get_results", {}),
          ]);
          const result = results.results.findLast((item) => item.proposal_id === proposal.id);
          const landed = change.method === "cancel"
            ? result?.status === "Canceled"
            : pending?.vote === change.vote;
          if (landed) {
            setActionState({ status: "success", change, txHash: null });
            await refreshAfterChange();
            return;
          }
        } catch {
        }
      }

      setActionState({
        status: "error",
        message: code
          ? friendlyVoteError(code)
          : "The vote change couldn't be confirmed. Check the seat's vote before trying again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  const changeHistory = historyState.status === "ready" ? historyState.change : null;
  const latestChange = changeHistory?.latest ?? null;
  const cancelChange = latestChange?.method === "cancel" ? latestChange : null;
  const cancelAttribution = cancelChange && seat
    ? changeAttribution(cancelChange.signerId, seat.controller, viewer.accountId)
    : null;
  const displayedVoteState = closedPending && voteState?.kind !== "cast"
    ? { kind: "missed" as const, pending: closedPending }
    : voteState;
  const currentVote = displayedVoteState?.kind === "pending"
    ? displayedVoteState.pending.vote
    : displayedVoteState?.kind === "cast"
      ? displayedVoteState.result.vote
      : null;
  const voteSource = displayedVoteState?.kind === "pending"
    ? "pending"
    : displayedVoteState?.kind === "cast"
      ? displayedVoteState.result.source
      : null;
  const retainedPending = closedPending ?? seat?.pending[proposal.id] ?? null;
  const originalVote = originalDelegateVote(changeHistory?.firstOverride);
  const isOverridden = isCurrentVoteOverridden(changeHistory, currentVote, voteSource);
  const controlsVisible = Boolean(
    seat && canChangePendingVote(displayedVoteState, seat.controller, viewer.accountId),
  );
  const otherVote = displayedVoteState?.kind === "pending" && displayedVoteState.pending.vote === "Approve"
    ? "Reject"
    : "Approve";
  const successHash = actionState.status === "success" ? actionState.txHash : null;

  return (
    <RuledSection title="Your delegate's vote">
      {viewer.error ? (
        <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
      ) : viewer.isLoading ? (
        <LoadingStatus>Checking this account's seats…</LoadingStatus>
      ) : tokenId !== undefined && viewer.accountId && !seat ? (
        <>
          <p className={s.muted}>This account doesn't hold Seat {tokenId}.</p>
          <TextButton href="#/seat">View your seat</TextButton>
        </>
      ) : !seat ? (
        <p className={s.muted}>Sign in with the account that holds a seat to view its delegate record.</p>
      ) : (
        <>
          {historyState.status === "error" && (
            <p className={s.muted}>
              Change history couldn't be loaded.{" "}
              <TextButton onClick={() => setHistoryAttempt((value) => value + 1)}>
                Retry
              </TextButton>
            </p>
          )}
          {viewer.accountId && seat.controller !== viewer.accountId && (
            <p className={s.muted}>
              This seat is controlled by <span className="mono">{seat.controller}</span>.
            </p>
          )}
          {isOverridden && latestChange?.method === "override_vote" && (
            <p className={s.muted}>
              <OverriddenStatus
                by={changeAttribution(latestChange.signerId, seat.controller, viewer.accountId)}
              />{" "}
              <TextButton href={explorerTxUrl(latestChange.txHash)}>View transaction</TextButton>
            </p>
          )}
          {actionState.status === "waiting" && (
            <LoadingStatus>Waiting for your wallet…</LoadingStatus>
          )}
          {actionState.status === "success" && (
            <>
              <SuccessStatus>
                {actionState.change.method === "cancel"
                  ? "Your seat won't vote on this proposal."
                  : `Your vote was changed to ${actionState.change.vote}.`}{" "}
                {successHash ? (
                  <TextButton href={explorerTxUrl(successHash)}>View transaction</TextButton>
                ) : (
                  "The transaction hash isn't available yet."
                )}
              </SuccessStatus>
              {refreshFailed && (
                <p className={s.muted}>
                  Your change went through, but the page couldn't refresh.{" "}
                  <TextButton
                    disabled={isSubmitting}
                    onClick={() => void retrySnapshotRefresh()}
                  >
                    Retry
                  </TextButton>
                </p>
              )}
            </>
          )}
          {actionState.status === "error" && <ErrorStatus>{actionState.message}</ErrorStatus>}

          {displayedVoteState?.kind === "cast" ? (
            <>
              <dl className={s.facts}>
                <Fact label="Vote">Your seat voted {displayedVoteState.result.vote}</Fact>
                <Fact label="Voter status"><CastStatus /></Fact>
                {displayedVoteState.result.receipt_hash && (
                  <Fact label="Receipt hash">
                    <HashValue value={displayedVoteState.result.receipt_hash} label="receipt hash" />
                  </Fact>
                )}
              </dl>
              {isOverridden && originalVote && retainedPending && (
                <p className={s.reason}>
                  Your delegate's reasoning for {originalVote}:{" "}
                  {retainedPending.reason}
                </p>
              )}
            </>
          ) : displayedVoteState?.kind === "closed" && displayedVoteState.result.status === "Canceled" ? (
            <>
              <dl className={s.facts}>
                <Fact label="Voter status"><RefusedStamp>Canceled</RefusedStamp></Fact>
              </dl>
              <p className={s.muted}>
                {cancelAttribution === "you"
                  ? "You canceled this vote"
                  : cancelAttribution === "member"
                    ? "Canceled by the member"
                    : cancelAttribution === "previous"
                      ? "Canceled by a previous member"
                      : "This vote was canceled"}
              </p>
              {cancelChange && (
                <TextButton href={explorerTxUrl(cancelChange.txHash)}>View transaction</TextButton>
              )}
            </>
          ) : displayedVoteState?.kind === "closed" ? (
            <dl className={s.facts}>
              <Fact label="Voter status">
                <RefusedStamp>{displayedVoteState.result.status}</RefusedStamp>
              </Fact>
            </dl>
          ) : displayedVoteState?.kind === "missed" ? (
            <div className={s.voteCard}>
              <VotingClosedStatus />
              <p className={s.reason}>
                Your delegate chose {displayedVoteState.pending.vote}, but it wasn't cast in time
              </p>
            </div>
          ) : displayedVoteState?.kind === "pending" ? (
            <div className={s.voteCard}>
              <div className={s.voteChoice}>
                <span className={`${s.voteWord} ${displayedVoteState.pending.vote === "Approve" ? s.voteApprove : ""}`}>
                  {displayedVoteState.pending.vote}
                </span>
                {displayedVoteState.sublabel === "windowClosed" ? (
                  <span className={s.muted}>
                    Override window closed at{" "}
                    <ProposalDate timestampNs={displayedVoteState.pending.deadline} />
                  </span>
                ) : (
                  <ProposalDeadline deadlineNs={BigInt(displayedVoteState.pending.deadline)} />
                )}
              </div>
              {displayedVoteState.sublabel === "casting" && <CastingStatus />}
              {displayedVoteState.sublabel === "retry" && <CastRetryStatus />}
              {displayedVoteState.sublabel === "windowClosed" && <WindowClosedStatus />}
              {isOverridden && originalVote ? (
                <p className={s.reason}>
                  Your delegate's reasoning for {originalVote}:{" "}
                  {displayedVoteState.pending.reason}
                </p>
              ) : (
                <p className={s.reason}>{displayedVoteState.pending.reason}</p>
              )}
              {controlsVisible && (
                <div className={s.actions}>
                  <p className={s.note}>Network fee about {networkFee ? `${networkFee} testnet NEAR` : "checking testnet network fee"}. No deposit.</p>
                  {confirmCancel ? (
                    <>
                      <p className={s.muted}>Your seat won't vote on this proposal.</p>
                      <GraphicButton
                        glyph="ticket"
                        disabled={isSubmitting}
                        onClick={() => void submitChange({ method: "cancel" })}
                      >
                        Confirm cancellation
                      </GraphicButton>
                      <TextButton
                        disabled={isSubmitting}
                        onClick={() => setConfirmCancel(false)}
                      >
                        Keep this vote
                      </TextButton>
                    </>
                  ) : (
                    <>
                      <GraphicButton
                        glyph="arrow"
                        disabled={isSubmitting}
                        onClick={() => void submitChange({
                          method: "override_vote",
                          vote: otherVote,
                        })}
                      >
                        Change vote to {otherVote}
                      </GraphicButton>
                      <TextButton
                        disabled={isSubmitting}
                        onClick={() => setConfirmCancel(true)}
                      >
                        Cancel this vote
                      </TextButton>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : proposal.status !== "InProgress" &&
            seat !== undefined &&
            closedPending === undefined ? (
            <LoadingStatus>Checking this seat's vote…</LoadingStatus>
          ) : displayedVoteState?.kind === "none" && displayedVoteState.votingClosed ? (
            <div className={s.voteCard}>
              <VotingClosedStatus />
              <p className={s.muted}>No vote from this seat</p>
            </div>
          ) : (
            <>
              <p className={s.muted}>Your delegate hasn't voted yet.</p>
              <ProposalDeadline
                deadlineNs={
                  BigInt(proposal.submission_time) + BigInt(state.data.proposalPeriodNs)
                }
              />
            </>
          )}
        </>
      )}
    </RuledSection>
  );
}

export function ProposalVote({
  closed = false,
  proposalId,
  tokenId,
}: {
  closed?: boolean;
  proposalId?: number;
  tokenId?: string;
}) {
  const state = useClubData();
  const viewer = useViewer();
  const nowNs = useCurrentTimeNs();
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const proposals = state.data.proposals;
  const openProposals = newestFirst(
    proposals.filter((item) => item.status === "InProgress"),
  );
  const requestedProposal = proposalId === undefined
    ? undefined
    : proposals.find((item) => item.id === proposalId);
  if (proposalId !== undefined && !requestedProposal) {
    return (
      <main className={s.page}>
        <header className={s.pageHead}>
          <p className={s.eyebrow}>Proposal {proposalId}</p>
          <h1>Proposal not found</h1>
        </header>
        <p className={s.muted}>This proposal isn't in the club's DAO.</p>
        <TextButton href="#/club">View DAO proposals</TextButton>
      </main>
    );
  }
  const requestedProposalVotingClosed =
    requestedProposal !== undefined &&
    (requestedProposal.status !== "InProgress" ||
      isProposalVotingClosed(requestedProposal, state.data.proposalPeriodNs, nowNs));
  const ownedSeats = state.data.seats.filter((item) =>
    viewer.seatIds.includes(item.token.token_id),
  );
  const routeSeat = tokenId === undefined
    ? undefined
    : ownedSeats.find((item) => item.token.token_id === tokenId);
  const seatWithPending = ownedSeats.find((item) =>
    openProposals.some((proposal) => {
      const votingClosed =
        proposal.status !== "InProgress" ||
        isProposalVotingClosed(proposal, state.data.proposalPeriodNs, nowNs);
      const voteState = seatVoteState(item, proposal.id, votingClosed, nowNs);
      return voteState.kind === "pending" || voteState.kind === "missed";
    }),
  );
  const seatForRequestedProposal = proposalId === undefined
    ? undefined
    : ownedSeats.find(
        (item) =>
          seatVoteState(item, proposalId, requestedProposalVotingClosed, nowNs).kind === "pending",
      ) ??
      ownedSeats.find(
        (item) =>
          seatVoteState(item, proposalId, requestedProposalVotingClosed, nowNs).kind === "cast",
      ) ??
      ownedSeats.find((item) => {
        const voteState = seatVoteState(item, proposalId, requestedProposalVotingClosed, nowNs);
        return voteState.kind === "closed" || voteState.kind === "missed";
      });
  const seatWithLatestCast = ownedSeats
    .map((item) => ({
      seat: item,
      result: item.results.results.findLast((result) => result.cast),
    }))
    .filter(({ result }) => Boolean(result))
    .sort(
      (left, right) =>
        (right.result?.proposal_id ?? -1) - (left.result?.proposal_id ?? -1),
    )[0]?.seat;
  const seat = tokenId !== undefined
    ? routeSeat
    : closed
      ? seatWithLatestCast ?? ownedSeats[0]
      : proposalId !== undefined
        ? seatForRequestedProposal ?? ownedSeats[0]
        : seatWithPending ?? ownedSeats[0];
  const latestCastResult = closed
    ? seat?.results.results.findLast((result) => result.cast)
    : undefined;
  const pendingProposal = seat
    ? openProposals.find((item) => {
        const votingClosed =
          item.status !== "InProgress" ||
          isProposalVotingClosed(item, state.data.proposalPeriodNs, nowNs);
        const voteState = seatVoteState(seat, item.id, votingClosed, nowNs);
        return voteState.kind === "pending" || voteState.kind === "missed";
      })
    : undefined;
  const proposal = closed
    ? proposals.find((item) => item.id === latestCastResult?.proposal_id)
    : proposalId !== undefined
      ? requestedProposal
      : pendingProposal ?? openProposals[0];
  const votingClosed =
    proposal !== undefined &&
    (proposal.status !== "InProgress" ||
      isProposalVotingClosed(proposal, state.data.proposalPeriodNs, nowNs));
  const voteState =
    proposal && seat ? seatVoteState(seat, proposal.id, votingClosed, nowNs) : undefined;

  if (!proposal) {
    return (
      <main className={s.page}>
        <header className={s.pageHead}>
          <p className={s.eyebrow}>Your delegate</p>
          <h1>{closed ? "No cast vote is available" : "No open proposals"}</h1>
        </header>
        <p className={s.muted}>
          {closed
            ? "This seat has no cast vote on record yet."
            : "There are no open proposals to review. You can see all DAO proposals on the club page."}
        </p>
        {!closed && <TextButton href="#/club">View DAO proposals</TextButton>}
      </main>
    );
  }

  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Proposal {proposal.id}</p>
        <h1 className={s.proposalTitle}>{proposal.description}</h1>
        <dl className={s.facts}>
          <Fact label="Kind">{proposalKindName(proposal)}</Fact>
          <Fact label="Proposer"><span className="mono">{proposal.proposer}</span></Fact>
          <Fact label="DAO status"><ProposalStatus proposal={proposal} periodNs={state.data.proposalPeriodNs} /></Fact>
        </dl>
      </header>

      <ProposalVoteMember
        state={state}
        viewer={viewer}
        proposal={proposal}
        seat={seat}
        voteState={voteState}
        tokenId={tokenId}
      />
    </main>
  );
}

export function AIReceiptPage() {
  const state = useClubData();
  const viewer = useViewer();
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const seats = viewer.accountId && !viewer.error && !viewer.isLoading
    ? state.data.seats.filter((seat) => viewer.seatIds.includes(seat.token.token_id))
    : state.data.seats;
  const results = seats.flatMap((seat) =>
    seat.results.results.map((result) => ({ seatId: seat.token.token_id, result })),
  );

  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>On-chain vote records</p>
        <h1>Delegate vote receipts</h1>
      </header>
      {viewer.error && (
        <RuledSection title="Your records">
          <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
          <p className={s.muted}>Public vote records are shown below.</p>
        </RuledSection>
      )}
      {!viewer.error && viewer.accountId && viewer.isLoading && (
        <RuledSection title="Your records">
          <LoadingStatus>Checking this account's seats…</LoadingStatus>
          <p className={s.muted}>Public vote records are shown while membership is checked.</p>
        </RuledSection>
      )}
      {results.length === 0 ? (
        <p className={s.muted}>No vote receipts are stored in the current voter views.</p>
      ) : results.map(({ seatId, result }) => (
        <RuledSection key={`${seatId}-${result.proposal_id}`} title={`Proposal ${result.proposal_id}`}>
          <dl className={s.facts}>
            <Fact label="Seat">{seatId}</Fact>
            <Fact label="Vote">{result.vote}</Fact>
            <Fact label="Voter status">
              {result.cast ? <CastStatus /> : <RefusedStamp>{result.status}</RefusedStamp>}
            </Fact>
            <Fact label="Source">{voteSourceLabel(result.source)}</Fact>
            <Fact label="Receipt hash">
              {result.receipt_hash ? (
                <HashValue value={result.receipt_hash} label="receipt hash" />
              ) : "No receipt hash stored"}
            </Fact>
            {result.error && <Fact label="Error">{result.error}</Fact>}
          </dl>
        </RuledSection>
      ))}
    </main>
  );
}

export function ReceiptPage({ kind }: { kind: "vote" | "sale" | "buy" | "vault" }) {
  const state = useClubData();
  const viewer = useViewer();
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const seats = viewer.accountId && !viewer.error && !viewer.isLoading
    ? state.data.seats.filter((seat) => viewer.seatIds.includes(seat.token.token_id))
    : state.data.seats;
  const results = kind === "vote"
    ? seats.flatMap((seat) => seat.results.results.map((result) => ({ seatId: seat.token.token_id, result })))
    : [];

  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Receipt</p>
        <h1>{kind === "vote" ? "Vote records" : `${kind[0].toUpperCase()}${kind.slice(1)} records`}</h1>
      </header>
      {viewer.error && (
        <RuledSection title="Your records">
          <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
          <p className={s.muted}>Public record information is shown below.</p>
        </RuledSection>
      )}
      {!viewer.error && viewer.accountId && viewer.isLoading && (
        <RuledSection title="Your records">
          <LoadingStatus>Checking this account's seats…</LoadingStatus>
          <p className={s.muted}>Public record information is shown while membership is checked.</p>
        </RuledSection>
      )}
      {results.length === 0 ? (
        <p className={s.muted}>
          Vote receipts are on the public record. Sale, purchase, and vault receipts aren't recorded.
        </p>
      ) : results.map(({ seatId, result }) => (
        <RuledSection key={`${seatId}-${result.proposal_id}`} title={`Proposal ${result.proposal_id}`}>
          <dl className={s.facts}>
            <Fact label="Seat">{seatId}</Fact>
            <Fact label="Vote">{result.vote}</Fact>
            <Fact label="Voter status">
              {result.cast ? <CastStatus /> : <RefusedStamp>{result.status}</RefusedStamp>}
            </Fact>
            {result.receipt_hash && (
              <Fact label="Receipt hash">
                <HashValue value={result.receipt_hash} label="receipt hash" />
              </Fact>
            )}
          </dl>
        </RuledSection>
      ))}
      <div className={s.actions}>
        <GraphicButton glyph="arrow" onClick={() => { location.hash = "#/seat"; }}>
          Back to my seat
        </GraphicButton>
      </div>
    </main>
  );
}

function StatusDemo({ kind }: { kind: "loading" | "success" | "error" }) {
  const run = useMockRun({ fail: kind === "error", ms: kind === "loading" ? 1e9 : 1600 });
  return (
    <span className={s.edgeDemo}>
      <span>
        <TextButton onClick={run.start}>Replay</TextButton>
      </span>
      {run.state === "idle" && <span className={s.muted}>Press replay to see the state.</span>}
      {run.state === "loading" && (
        <LoadingStatus>
          Checking your seat. Verified public OS on genuine Intel and NVIDIA hardware.
        </LoadingStatus>
      )}
      {run.state === "success" && <SuccessStatus>Vault opened. Content encrypted to your key.</SuccessStatus>}
      {run.state === "error" && <ErrorStatus onRetry={run.start}>The check didn't finish. Nothing was opened.</ErrorStatus>}
    </span>
  );
}

const STATE_EXAMPLES: { name: string; render: () => JSX.Element }[] = [
  { name: "Pending, window open", render: () => <PendingStatus deadline="14:32" countdown="1:42" /> },
  { name: "Overridden", render: () => <OverriddenStatus by="you" /> },
  { name: "Cast", render: () => <CastStatus /> },
  { name: "Approved", render: () => <ResultStamp result="Approved" /> },
  { name: "Rejected", render: () => <ResultStamp result="Rejected" /> },
  { name: "Expired", render: () => <ResultStamp result="Expired" /> },
  { name: "Checked on-chain", render: () => <CheckedStamp /> },
  { name: "Refused by design", render: () => <RefusedStamp>Not allowed</RefusedStamp> },
];

export function StatesPage() {
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Design review</p>
        <h1>Status tokens</h1>
        <p className={s.lede}>
          Every status is a word plus a shape or rule, never colour alone.
        </p>
      </header>
      <RuledSection title="Loading, error and success">
        <ul className={s.stateList}>
          <li className={s.stateRow}>
            <span className={s.stateName}>Loading</span>
            <StatusDemo kind="loading" />
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Success</span>
            <StatusDemo kind="success" />
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Error</span>
            <StatusDemo kind="error" />
          </li>
        </ul>
      </RuledSection>
      <RuledSection title="Status examples">
        <ul className={s.stateList}>
          {STATE_EXAMPLES.map((e) => (
            <li key={e.name} className={s.stateRow}>
              <span className={s.stateName}>{e.name}</span>
              {e.render()}
            </li>
          ))}
        </ul>
      </RuledSection>
      <RuledSection title="Edge states">
        <ul className={s.stateList}>
          <li className={s.stateRow}>
            <span className={s.stateName}>No seat yet</span>
            <span className={s.muted}>Visitors can apply from the club page.</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Seat held, no brief</span>
            <span className={s.edgeDemo}>
              <span className={s.muted}>Your seat is held. Your delegate can't vote until you write a brief.</span>
              <span className={s.muted}>This fixture represents a seat with no saved brief.</span>
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Brief set, no open proposals</span>
            <span className={s.muted}>Your brief is saved. No proposal needs a vote right now.</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Delegate thinking</span>
            <span className={s.muted}>
              Your delegate is reading proposal 12. Verified public OS on genuine Intel and NVIDIA hardware.
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Offer waiting for club</span>
            <span className={s.muted}>The club is reviewing your offer. Your funds stay in escrow and come back if it's declined or expires.</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Vault checking</span>
            <span className={s.muted}>
              Checking your seat. Verified public OS on genuine Intel and NVIDIA hardware.
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Window closed</span>
            <span className={s.edgeDemo}>
              <WindowBar deadline="14:32" countdown="0:00" fraction={0} />
              <span className={s.muted}>The override window closed at 14:32.</span>
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Late override refused</span>
            <span>
              <RefusedStamp>Not allowed</RefusedStamp>{" "}
              <span className={s.muted}>The override window closed at 14:32.</span>
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Sale declined, refunded</span>
            <ReceiptSteps
              steps={[
                { label: "Escrow returned in full", tx: "CHTc8EBxop8t6Z3qL3XzSDnCHBWejRxAvVKbaABFRahu" },
              ]}
            />
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Former member, vault</span>
            <span>
              <RefusedStamp>Not allowed</RefusedStamp>{" "}
              <span className={s.muted}>Only current seat holders can open the vault.</span>
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Network slow</span>
            <span className={s.muted}>
              Your delegate is reading proposal 8. Verified public OS on genuine Intel and NVIDIA hardware.
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Wallet not connected</span>
            <span className={s.muted}>Not connected</span>
          </li>
        </ul>
      </RuledSection>
    </main>
  );
}
