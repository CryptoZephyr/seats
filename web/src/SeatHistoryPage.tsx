import { useEffect, useState } from "react";
import { useClubData } from "./chain/useClubData";
import {
  isCurrentVoteOverridden,
  latestMemberChanges,
  type MemberChangeHistory,
} from "./chain/history";
import {
  loadSeatOwnershipHistory,
  seatHolderDescription,
  type SeatOwnershipHistory,
} from "./chain/seatHistory";
import { explorerTxUrl, formatNearAmount } from "./chain/transactions";
import { formatProposalDate } from "./proposalDate";
import { SeatArtwork } from "./SeatArtwork";
import { VoteMark } from "./seatplan";
import {
  ErrorStatus,
  LoadingStatus,
  RuledSection,
  TextButton,
} from "./ui";
import type { VoteResult } from "./chain/types";
import s from "./SeatHistoryPage.module.css";
import pageStyles from "./screens.module.css";

type HistoryState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | {
      status: "ready";
      ownership: SeatOwnershipHistory;
      memberChanges: Map<number, MemberChangeHistory>;
    };

function decidedBy(
  result: VoteResult,
  changes: MemberChangeHistory | undefined,
): string {
  if (result.status === "Canceled") return "Canceled";
  return result.source === "member" ||
    changes?.latest?.method === "override_vote" ||
    isCurrentVoteOverridden(changes ?? null, result.vote, result.source)
    ? "Member override"
    : "Delegate";
}

function VoteDecision({ result }: { result: VoteResult }) {
  if (result.vote !== "Approve" && result.vote !== "Reject") return null;
  return (
    <span className={s.voteWord}>
      <VoteMark kind={result.vote === "Approve" ? "tick" : "cross"} size={16} />
      {result.vote}
    </span>
  );
}

export function SeatHistoryPage({ tokenId }: { tokenId: string }) {
  const state = useClubData();
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<HistoryState>({ status: "loading" });
  const seat = state.status === "ready"
    ? state.data.seats.find((item) => item.token.token_id === tokenId)
    : undefined;
  const voterId = seat?.record.voter_id;
  const results = seat?.results;

  useEffect(() => {
    let active = true;
    if (state.status !== "ready" || !seat || !voterId || !results) {
      return () => { active = false; };
    }
    setHistory({ status: "loading" });
    void Promise.all([
      loadSeatOwnershipHistory(tokenId),
      latestMemberChanges(voterId, results.results.map((result) => result.proposal_id)),
    ])
      .then(([ownership, memberChanges]) => {
        if (active) setHistory({ status: "ready", ownership, memberChanges });
      })
      .catch((error: unknown) => {
        if (active) {
          setHistory({
            status: "error",
            error: error instanceof Error ? error : new Error("Seat history couldn't be loaded."),
          });
        }
      });
    return () => { active = false; };
  }, [state.status, seat, tokenId, voterId, results, attempt]);

  const title = `Seat ${tokenId} history`;
  return (
    <main className={`${pageStyles.page} ${pageStyles.pageWide}`}>
      <header className={pageStyles.pageHead}>
        <p className={pageStyles.eyebrow}>Public seat record</p>
        <h1>{title}</h1>
        {seat && (
          <div className={s.historyHead}>
            <SeatArtwork
              seatId={tokenId}
              media={seat.token.metadata?.media}
              className={s.historyArtwork}
            />
            <span className="mono">{seat.token.owner_id}</span>
          </div>
        )}
      </header>

      {state.status === "loading" ? (
        <LoadingStatus>Reading seat history…</LoadingStatus>
      ) : state.status === "error" ? (
        <ErrorStatus onRetry={state.retry}>{state.error.message}</ErrorStatus>
      ) : !seat ? (
        <RuledSection title="Seat not found">
          <p className={pageStyles.muted}>Seat {tokenId} isn't available in the club snapshot.</p>
          <TextButton href="#/club">View the club</TextButton>
        </RuledSection>
      ) : history.status === "loading" ? (
        <LoadingStatus>Loading holders, sales, and votes…</LoadingStatus>
      ) : history.status === "error" ? (
        <ErrorStatus onRetry={() => setAttempt((value) => value + 1)}>
          {history.error.message}
        </ErrorStatus>
      ) : (
        <>
          <RuledSection title="Holders">
            {history.ownership.holders.length === 0 ? (
              <p className={pageStyles.muted}>No holder changes are recorded for this seat yet.</p>
            ) : (
              <ul className={s.historyList}>
                {history.ownership.holders.map((holder) => {
                  const date = formatProposalDate(holder.timestampNs);
                  return (
                    <li key={holder.txHash} className={s.historyRow}>
                      <div className={s.historyMain}>
                        <strong className="mono">{holder.ownerId}</strong>
                        <span>{seatHolderDescription(holder)}</span>
                        <time dateTime={date.datetime} title={date.tooltip}>{date.text}</time>
                      </div>
                      <a className={s.historyLink} href={explorerTxUrl(holder.txHash)} target="_blank" rel="noreferrer">
                        View transaction
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </RuledSection>

          <RuledSection title="Sales">
            {history.ownership.sales.length === 0 ? (
              <p className={pageStyles.muted}>No completed sales are recorded for this seat.</p>
            ) : (
              <ul className={s.historyList}>
                {history.ownership.sales.map((sale) => {
                  const date = formatProposalDate(sale.timestampNs);
                  return (
                    <li key={sale.txHash} className={s.saleRow}>
                      <div className={s.historyMain}>
                        <strong className="mono">{sale.sellerId} to {sale.buyerId}</strong>
                        <dl className={s.saleSplit}>
                          <div><dt>Price</dt><dd>{formatNearAmount(sale.priceYocto)} NEAR</dd></div>
                          <div><dt>Seller, 95%</dt><dd>{formatNearAmount(sale.sellerAmountYocto)} NEAR</dd></div>
                          <div><dt>Club, 5%</dt><dd>{formatNearAmount(sale.clubAmountYocto)} NEAR</dd></div>
                        </dl>
                        <time dateTime={date.datetime} title={date.tooltip}>{date.text}</time>
                      </div>
                      <a className={s.historyLink} href={explorerTxUrl(sale.txHash)} target="_blank" rel="noreferrer">
                        View transaction
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </RuledSection>

          <RuledSection title={`Seat ${tokenId}'s delegate votes`}>
            {(results?.results.length ?? 0) === 0 ? (
              <p className={pageStyles.muted}>No vote results are recorded for this delegate yet.</p>
            ) : (
              <ul className={s.historyList}>
                {[...(results?.results ?? [])].sort((left, right) => right.proposal_id - left.proposal_id).map((result) => {
                  const proposal = state.data.proposals.find((item) => item.id === result.proposal_id);
                  const changes = history.memberChanges.get(result.proposal_id);
                  return (
                    <li key={result.proposal_id} className={s.voteRow}>
                      <div className={s.historyMain}>
                        <TextButton href={`#/vote/${result.proposal_id}/${tokenId}`}>
                          Proposal {result.proposal_id}: {proposal?.description ?? "Proposal details"}
                        </TextButton>
                        <div className={s.voteDetails}>
                          <VoteDecision result={result} />
                          <span className={s.voteWord}>
                            <VoteMark kind="ring" size={16} />
                            {decidedBy(result, changes)}
                          </span>
                          <span className={s.voteWord}>
                            <VoteMark kind={result.cast ? "tick" : "ring"} size={16} />
                            {result.cast ? "Cast" : "Not cast"}
                          </span>
                          {result.receipt_hash && <a href="#/aireceipt">View receipt</a>}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </RuledSection>
        </>
      )}
    </main>
  );
}
