import { useEffect, useState } from "react";
import { chainConfig } from "./chain/config";
import type { ProposalView } from "./chain/types";
import { callView } from "./chain/rpc";
import { useClubData } from "./chain/useClubData";
import { useViewer } from "./chain/WalletProvider";
import {
  buildApplyRequest,
  buildClaimRequest,
  CLAIM_SEAT_GAS,
  contractErrorCode,
  friendlyContractError,
  PROPOSAL_CALL_GAS,
} from "./chain/transactions";
import { formatProposalDate } from "./proposalDate";
import { isProposalVotingClosed } from "./proposals";
import { ErrorStatus, Fact, GraphicButton, LoadingStatus, PendingStatus, ResultStamp, RuledSection, SuccessStatus } from "./ui";
import { checkFunds, friendly, near, PageHead, TxLink, useGasEstimate } from "./flowCommon";
import s from "./screens.module.css";

const findApplication = (proposals: ProposalView[], accountId: string) =>
  [...proposals].reverse().find((proposal) => proposal.description === `Apply for a seat for ${accountId}`);

function Deadline({ value }: { value: bigint }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.floor((Number(value / 1_000_000n) - now) / 1000));
  return <PendingStatus
    deadline={formatProposalDate(value).time}
    countdown={`${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}
  />;
}

export function ApplyClaimPage() {
  const state = useClubData();
  const viewer = useViewer();
  const [expiry, setExpiry] = useState<string | null>(null);
  const [approvalState, setApprovalState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ hash: string; action: "apply" | "claim" } | null>(null);
  const claimWindowOpen = expiry !== null && BigInt(Date.now()) * 1_000_000n < BigInt(expiry);
  const gasEstimate = useGasEstimate(claimWindowOpen ? CLAIM_SEAT_GAS : PROPOSAL_CALL_GAS);

  useEffect(() => {
    let active = true;
    if (!viewer.accountId) {
      setExpiry(null);
      setApprovalState("ready");
      return () => { active = false; };
    }
    setApprovalState("loading");
    void callView(chainConfig.seatNftAccountId, "get_application_approval", { applicant: viewer.accountId })
      .then((value) => {
        if (active) {
          setExpiry(value == null ? null : String(value));
          setApprovalState("ready");
        }
      })
      .catch(() => { if (active) setApprovalState("error"); });
    return () => { active = false; };
  }, [viewer.accountId, state.status, attempt]);

  if (state.status === "loading") return <main className={s.page}><LoadingStatus>Reading testnet applications…</LoadingStatus></main>;
  if (state.status === "error") return <main className={s.page}><ErrorStatus onRetry={state.retry}>{state.error.message}</ErrorStatus></main>;
  if (state.status !== "ready") return null;
  const now = BigInt(Date.now()) * 1_000_000n;
  const application = viewer.accountId ? findApplication(state.data.proposals, viewer.accountId) : undefined;
  const inVote = application?.status === "InProgress" &&
    !isProposalVotingClosed(application, state.data.proposalPeriodNs, now);
  const expiryNs = expiry === null ? null : BigInt(expiry);
  const claimable = expiryNs !== null && now < expiryNs;
  const approvalExpired = expiryNs !== null && now >= expiryNs;
  const previousDecision = approvalExpired ||
    Boolean(application && ["Rejected", "Expired", "Removed"].includes(application.status));

  const submit = async (action: "apply" | "claim") => {
    setError("");
    setResult(null);
    if (!viewer.accountId) return;
    const request = action === "apply"
      ? buildApplyRequest(viewer.accountId, state.data.proposalBond)
      : buildClaimRequest(chainConfig.runnerAgentPublicKey);
    setBusy(true);
    try {
      if (!await checkFunds(viewer.accountId, request)) {
        throw new Error(`This account needs ${near(request.deposit)} NEAR plus gas. Get testnet NEAR from a NEAR testnet faucet.`);
      }
      const tx = await viewer.callContract(request);
      setResult({ hash: tx.hash, action });
      state.retry();
      viewer.retry();
    } catch (cause) {
      const code = contractErrorCode(cause);
      setError(code ? friendlyContractError(code) : friendly(cause));
    } finally { setBusy(false); }
  };

  const tallies = Object.values(application?.vote_counts ?? {});
  const approveCount = tallies.reduce((sum, tally) => sum + tally[0], 0);
  const rejectCount = tallies.reduce((sum, tally) => sum + tally[1], 0);
  return <main className={s.page}>
    <PageHead eyebrow="Join the club" title="Apply for a seat">
      <p className={s.lede}>Your delegate votes from your private brief while you're away.</p>
    </PageHead>
    <RuledSection title="Your application">
      {!viewer.accountId ? <p className={s.muted}>Sign in with a NEAR testnet account to apply.</p>
        : viewer.isLoading || approvalState === "loading" ? <LoadingStatus>Checking your seat and application…</LoadingStatus>
        : viewer.isSeatHolder ? <p>You already hold a seat in this club.</p>
        : inVote && application ? <>
          <p>Application in vote: proposal {application.id}</p>
          <p>Tally: {approveCount} approve, {rejectCount} reject.</p>
          <Deadline value={BigInt(application.submission_time) + BigInt(state.data.proposalPeriodNs)} />
        </> : claimable && expiryNs !== null ? <>
          <p><ResultStamp result="Approved" /> Claim your seat before this approval expires.</p>
          <p>Approval expires <time>{formatProposalDate(expiryNs).text}</time>.</p>
        </> : <>
          {approvalExpired ? <p>The seat approval expired. You can apply again.</p>
            : previousDecision && application ? <p>The last application was {application.status.toLowerCase()}. You can apply again.</p> : null}
          <p>Application decisions are recorded on the club's testnet DAO.</p>
        </>}
      {viewer.accountId && !viewer.isLoading && !viewer.isSeatHolder && !inVote && approvalState === "ready" && (
        <>
          <dl className={s.facts}>
            <Fact label="Proposal bond">{near(BigInt(state.data.proposalBond))} NEAR, returned when the proposal is decided</Fact>
            <Fact label="Claim deposit">4.5 NEAR funds your delegate. Nearly all is returned after each vote.</Fact>
            <Fact label="Estimated gas">{gasEstimate ? `${gasEstimate} NEAR at the current testnet gas price` : "Current testnet gas price is unavailable"}</Fact>
          </dl>
          <GraphicButton glyph="seat" onClick={() => void submit(claimable ? "claim" : "apply")} disabled={busy}>
            {claimable ? "Claim seat" : "Apply"}
          </GraphicButton>
        </>
      )}
      {approvalState === "error" && <ErrorStatus onRetry={() => setAttempt((value) => value + 1)}>Your application approval couldn't be read.</ErrorStatus>}
      {error && <ErrorStatus>{error}</ErrorStatus>}
      {busy && <LoadingStatus>Waiting for your wallet…</LoadingStatus>}
      {result && <SuccessStatus>{result.action === "apply" ? "Application submitted." : "Seat claimed."} <TxLink hash={result.hash} /></SuccessStatus>}
      {!viewer.accountId && <p className={s.note}>Use a testnet NEAR wallet and testnet NEAR from a NEAR testnet faucet.</p>}
    </RuledSection>
  </main>;
}
