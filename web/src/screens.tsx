import { useEffect, useState, type JSX } from "react";
import { chainConfig } from "./chain/config";
import type { SeatSnapshot } from "./chain/club";
import { useClubData } from "./chain/useClubData";
import { useViewer } from "./chain/WalletProvider";
import type { PendingView, ProposalView, VoteResult } from "./chain/types";
import { formatProposalDate } from "./proposalDate";
import { isProposalVotingClosed, newestFirst } from "./proposals";
import { SeatPlan, VoteMark, type VoteKind } from "./seatplan";
import { useMockRun } from "./useMockRun";
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
  Icon,
  OverriddenStatus,
  PendingStatus,
  ReceiptSteps,
  RefusedStamp,
  ResultStamp,
  RuledSection,
  TextButton,
  VotingClosedStatus,
  WindowClosedStatus,
  WindowBar,
} from "./ui";
import s from "./screens.module.css";

type ClubDataState = ReturnType<typeof useClubData>;

function ReadPageState({ state, retry }: { state: ClubDataState; retry: () => void }) {
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

function saleArgs(args: string): { seatId: string | null; buyerId: string | null; price: string | null } {
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

function saleListings(proposals: ProposalView[]) {
  return proposals.flatMap((proposal) => {
    if (
      proposal.status !== "InProgress" ||
      typeof proposal.kind !== "object" ||
      proposal.kind === null ||
      !("FunctionCall" in proposal.kind)
    ) {
      return [];
    }
    const functionCall = proposal.kind.FunctionCall;
    if (functionCall.receiver_id !== chainConfig.seatNftAccountId) return [];
    return functionCall.actions
      .filter((action) => action.method_name === "approve_sale")
      .map((action) => ({ proposal, ...saleArgs(action.args) }));
  });
}

const SALE_LEVY_BPS = 500n;

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

function saleSplit(price: string) {
  const amount = BigInt(price);
  const levy = amount * SALE_LEVY_BPS / 10_000n;
  return { seller: amount - levy, levy };
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
  const split = saleSplit(listing.price);
  return (
    <dl className={s.facts}>
      <Fact label="Buyer"><span className="mono">{listing.buyerId}</span></Fact>
      <Fact label="Price and split">
        <MoneySplit
          price={nearAmount(listing.price)}
          sellerPct={nearAmount(split.seller.toString())}
          levyPct={nearAmount(split.levy.toString())}
        />
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
  const saleProposals = saleListings(data.proposals);
  const seats = data.seats.map((seat) => ({
    seat: seat.token.token_id,
    ownerId: seat.token.owner_id,
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
            </div>
          ))}
        </dl>
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
                              Override window closed at{" "}
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
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const seats = state.data.seats.filter((seat) => viewer.seatIds.includes(seat.token.token_id));

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
        {!viewer.accountId ? (
          <p className={s.muted}>Sign in to see fingerprints for seats held by this account.</p>
        ) : viewer.isLoading ? (
          <LoadingStatus>Checking this account's seats…</LoadingStatus>
        ) : viewer.error ? (
          <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
        ) : seats.length > 0 ? (
          <dl className={s.facts}>
            {seats.map((seat) => (
              <Fact key={seat.token.token_id} label={`Seat ${seat.token.token_id} fingerprint`}>
                {seat.briefHash ? (
                  <HashValue value={seat.briefHash} label="brief fingerprint" />
                ) : "No fingerprint stored"}
              </Fact>
            ))}
          </dl>
        ) : (
          <p className={s.muted}>This account does not hold a seat with a public brief fingerprint.</p>
        )}
        <p className={s.note}>Brief text is private and isn't included in public testnet reads.</p>
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
  const seat = routeSeat ?? (
    closed
      ? seatWithLatestCast ?? ownedSeats[0]
      : proposalId !== undefined
        ? seatForRequestedProposal ?? ownedSeats[0]
        : seatWithPending ?? ownedSeats[0]
  );
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
        <h1>{proposal.description}</h1>
        <dl className={s.facts}>
          <Fact label="Kind">{proposalKindName(proposal)}</Fact>
          <Fact label="Proposer"><span className="mono">{proposal.proposer}</span></Fact>
          <Fact label="DAO status"><ProposalStatus proposal={proposal} periodNs={state.data.proposalPeriodNs} /></Fact>
        </dl>
      </header>

      <RuledSection title="Your delegate's vote">
        {viewer.error ? (
          <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
        ) : viewer.isLoading ? (
          <LoadingStatus>Checking this account's seats…</LoadingStatus>
        ) : tokenId !== undefined && viewer.accountId && !routeSeat ? (
          <>
            <p className={s.muted}>This account doesn't hold Seat {tokenId}.</p>
            <TextButton href="#/seat">View your seat</TextButton>
          </>
        ) : !seat ? (
          <p className={s.muted}>Sign in with the account that holds a seat to view its delegate record.</p>
        ) : voteState?.kind === "cast" ? (
          <dl className={s.facts}>
            <Fact label="Vote">Your seat voted {voteState.result.vote}</Fact>
            <Fact label="Voter status">
              <CastStatus />
            </Fact>
            {voteState.result.receipt_hash && (
              <Fact label="Receipt hash">
                <HashValue value={voteState.result.receipt_hash} label="receipt hash" />
              </Fact>
            )}
          </dl>
        ) : voteState?.kind === "closed" ? (
          <dl className={s.facts}>
            <Fact label="Voter status">
              <RefusedStamp>{voteState.result.status}</RefusedStamp>
            </Fact>
          </dl>
        ) : voteState?.kind === "missed" ? (
          <div className={s.voteCard}>
            <VotingClosedStatus />
            <p className={s.reason}>
              Your delegate chose {voteState.pending.vote}, but it wasn't cast in time
            </p>
          </div>
        ) : voteState?.kind === "pending" ? (
          <div className={s.voteCard}>
            <div className={s.voteChoice}>
              <span className={`${s.voteWord} ${voteState.pending.vote === "Approve" ? s.voteApprove : ""}`}>
                {voteState.pending.vote}
              </span>
              {voteState.sublabel === "windowClosed" ? (
                <span className={s.muted}>
                  Override window closed at{" "}
                  <ProposalDate timestampNs={voteState.pending.deadline} />
                </span>
              ) : (
                <ProposalDeadline deadlineNs={BigInt(voteState.pending.deadline)} />
              )}
            </div>
            {voteState.sublabel === "casting" && <CastingStatus />}
            {voteState.sublabel === "retry" && <CastRetryStatus />}
            {voteState.sublabel === "windowClosed" && <WindowClosedStatus />}
            <p className={s.reason}>{voteState.pending.reason}</p>
          </div>
        ) : voteState?.kind === "none" && voteState.votingClosed ? (
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
      </RuledSection>

      {!closed && voteState?.kind === "pending" && viewer.isVoterController && (
        <RuledSection title="Override before it is cast">
          <p className={s.muted}>Vote changes are not available in this phase.</p>
        </RuledSection>
      )}
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

export function VaultPage() {
  const viewer = useViewer();
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>{viewer.seatIds.length === 1 ? `Seat ${viewer.seatIds[0]}` : "Your seat"}</p>
        <h1>Club vault</h1>
      </header>

      <RuledSection inset>
        <div className={s.vaultBox}>
          <p className={s.vaultIcon} aria-hidden="true">
            <Icon name="vault" size={40} />
          </p>
          {viewer.error ? (
            <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
          ) : viewer.isLoading ? (
            <LoadingStatus>Checking the connected account's seats on testnet…</LoadingStatus>
          ) : !viewer.accountId ? (
            <p className={s.muted}>
              Sign in with the wallet that holds your seat to check your vault access.
            </p>
          ) : viewer.isSeatHolder ? (
            <p className={s.muted}>
              Your seat opens the vault. Opening it from this site isn't available yet.
            </p>
          ) : (
            <p>
              <RefusedStamp>Not allowed</RefusedStamp>{" "}
              <span className={s.muted}>Only current seat holders can open the vault.</span>
            </p>
          )}
        </div>
      </RuledSection>

    </main>
  );
}

export function SellSeat() {
  const state = useClubData();
  const viewer = useViewer();
  const nowNs = useCurrentTimeNs();
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const approvals = activeSaleApprovals(state.data.seats, nowNs);
  const listings = saleListings(state.data.proposals);
  const ownedSeats = state.data.seats.filter((seat) => viewer.seatIds.includes(seat.token.token_id));

  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Your seats</p>
        <h1>Sell your seat</h1>
        <p className={s.lede}>
          This page shows active sale approvals and proposals waiting for the club.
        </p>
      </header>

      {viewer.error ? (
        <ErrorStatus onRetry={viewer.retry}>{viewer.error.message}</ErrorStatus>
      ) : viewer.accountId && viewer.isLoading ? (
        <LoadingStatus>Checking this account's seats…</LoadingStatus>
      ) : !viewer.accountId ? (
        <RuledSection title="Your seat">
          <p className={s.muted}>Sign in with an account that holds a seat to review its sale proposals.</p>
        </RuledSection>
      ) : ownedSeats.length === 0 ? (
        <RuledSection title="Your seat">
          <p className={s.muted}>This account does not hold a seat.</p>
        </RuledSection>
      ) : (
        ownedSeats.map((seat) => {
          const approval = approvals.find((item) => item.seatId === seat.token.token_id);
          const listing = listings.find((item) => item.seatId === seat.token.token_id);
          return (
            <RuledSection key={seat.token.token_id} title={`Seat ${seat.token.token_id}`}>
              <p className={s.eyebrow}>For sale</p>
              {approval ? (
                <SaleApprovalDetails listing={approval} />
              ) : (
                <p className={s.muted}>No active sale approval for this seat.</p>
              )}
              <p className={s.eyebrow}>Awaiting club vote</p>
              {listing ? (
                <dl className={s.facts}>
                  <Fact label="Proposal">#{listing.proposal.id}</Fact>
                  <Fact label="Status">
                    <ProposalStatus proposal={listing.proposal} periodNs={state.data.proposalPeriodNs} />
                  </Fact>
                  {listing.buyerId && <Fact label="Buyer"><span className="mono">{listing.buyerId}</span></Fact>}
                  {listing.price && <Fact label="Price">{nearAmount(listing.price)} NEAR</Fact>}
                </dl>
              ) : (
                <p className={s.muted}>No sale proposal is waiting for the club for this seat.</p>
              )}
              <p className={s.note}>Creating or canceling a sale is not available in this phase.</p>
            </RuledSection>
          );
        })
      )}
    </main>
  );
}

export function BuySeat() {
  const state = useClubData();
  const nowNs = useCurrentTimeNs();
  const pageState = ReadPageState({ state, retry: state.retry });
  if (pageState) return pageState;
  if (state.status !== "ready") return null;

  const approvals = activeSaleApprovals(state.data.seats, nowNs);
  const listings = saleListings(state.data.proposals);

  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Seat for sale</p>
        <h1>Seats for sale</h1>
      </header>

      <RuledSection title="For sale">
        {approvals.length === 0 ? (
          <p className={s.muted}>No seats are for sale right now.</p>
        ) : (
          approvals.map((listing) => (
            <div key={listing.seatId} className={s.listing}>
              <div>
                <strong>Seat {listing.seatId}</strong>
                <span className={s.muted}> · held by <span className="mono">{listing.sellerId}</span></span>
              </div>
              <SaleApprovalDetails listing={listing} />
            </div>
          ))
        )}
        <p className={s.note}>Buying a seat is not available in this phase.</p>
      </RuledSection>

      <RuledSection title="Awaiting club vote">
        {listings.length === 0 ? (
          <p className={s.muted}>No seat sales are waiting for a club vote.</p>
        ) : (
          listings.map((listing) => {
            const holder = state.data.tokens.find((token) => token.token_id === listing.seatId)?.owner_id;
            return (
              <div key={listing.proposal.id} className={s.listing}>
                <div>
                  <strong>
                    {listing.seatId ? `Seat ${listing.seatId}` : `Proposal ${listing.proposal.id}`}
                  </strong>
                  {holder && (
                    <span className={s.muted}> · held by <span className="mono">{holder}</span></span>
                  )}
                </div>
                <dl className={s.facts}>
                  <Fact label="Proposal">#{listing.proposal.id}: {listing.proposal.description}</Fact>
                  <Fact label="Status">
                    <ProposalStatus proposal={listing.proposal} periodNs={state.data.proposalPeriodNs} />
                  </Fact>
                  {listing.buyerId && (
                    <Fact label="Buyer"><span className="mono">{listing.buyerId}</span></Fact>
                  )}
                  {listing.price && <Fact label="Price">{nearAmount(listing.price)} NEAR</Fact>}
                </dl>
              </div>
            );
          })
        )}
      </RuledSection>
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
  { name: "Overridden", render: () => <OverriddenStatus /> },
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
            <span className={s.muted}>Applications are not available in this phase.</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Seat held, no brief</span>
            <span className={s.edgeDemo}>
              <span className={s.muted}>Your seat is held. Your delegate can't vote until you write a brief.</span>
              <span className={s.muted}>Brief editing is not available in this phase.</span>
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
