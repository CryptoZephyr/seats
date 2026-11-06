import type { JSX } from "react";
import {
  AI_RECEIPT,
  CLUB,
  EXPLORER,
  LISTINGS,
  ME,
  OPEN_PROPOSALS,
  PENDING_VOTE,
  RECENT_DECISIONS,
  SALE,
  SALE_TX_APPROVE,
  SALE_TX_BUY,
  VAULT,
} from "./data";
import { SeatPlan, VoteMark } from "./seatplan";
import { useMockRun } from "./useMockRun";
import {
  CastStatus,
  ErrorStatus,
  LoadingStatus,
  SuccessStatus,
  CheckedStamp,
  Fact,
  GraphicButton,
  Icon,
  MoneySplit,
  OverriddenStatus,
  PendingStatus,
  ReceiptSteps,
  RefusedStamp,
  ResultStamp,
  RuledSection,
  TextButton,
  WindowBar,
} from "./ui";
import s from "./screens.module.css";

export function ClubPage() {
  return (
    <main className={`${s.page} ${s.pageWide}`}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>A Sputnik DAO club</p>
        <h1>{CLUB.name}</h1>
        <p className={s.lede}>
          Each seat carries one vote in the club's DAO and opens the club vault. Seats move only
          through a club-approved sale.
        </p>
      </header>

      <RuledSection
        title="The seat plan"
        aside={<span className={s.muted}>{CLUB.seatsHeld} of {CLUB.seatCap} seats held</span>}
        inset
      >
        <SeatPlan />
        <p className={s.legend}>
          <span><i className={`${s.swatch} ${s.swatchHeld}`} /> Held</span>
          <span><i className={`${s.swatch} ${s.swatchEmpty}`} /> Open</span>
          <span><i className={`${s.swatch} ${s.swatchMine}`} /> Yours</span>
          <span><VoteMark kind="tick" size={14} /> Approve</span>
          <span><VoteMark kind="cross" size={14} /> Reject</span>
          <span><VoteMark kind="ring" size={14} /> Abstain</span>
        </p>
      </RuledSection>

      <RuledSection title="What a seat gives">
        <ul className={s.gives}>
          <li>One vote in the club's Sputnik DAO</li>
          <li>Access to the club vault</li>
          <li>A delegate that votes from your private brief</li>
        </ul>
      </RuledSection>

      <RuledSection title="Recent decisions">
        <ul className={s.decisions}>
          {RECENT_DECISIONS.map((d) => (
            <li key={d.id} className={s.decision}>
              <div className={s.decisionMain}>
                <span className={s.decisionTitle}>
                  Proposal {d.id}: {d.title}
                </span>
                <span className={s.decisionDetail}>{d.detail}</span>
                <span className={s.decisionTime}>{d.time}</span>
              </div>
              <div className={s.decisionSide}>
                <ResultStamp result={d.result} />
                <a className={s.txLink} href={`${EXPLORER}/tx/${d.tx}`} target="_blank" rel="noreferrer">
                  tx <Icon name="external" size={11} />
                </a>
              </div>
            </li>
          ))}
        </ul>
      </RuledSection>

      <RuledSection
        title="Seats for sale"
        aside={
          LISTINGS.length > 0 ? (
            <GraphicButton glyph="padlock" onClick={() => { location.hash = "#/buy"; }}>
              Buy a seat
            </GraphicButton>
          ) : undefined
        }
      >
        {LISTINGS.length === 0 ? (
          <p className={s.muted}>No seats are listed right now.</p>
        ) : (
          <ul className={s.listings}>
            {LISTINGS.map((l) => (
              <li key={l.seat} className={s.listing}>
                <div>
                  <strong>Seat {l.seat}</strong>
                  <span className={s.muted}> · held by {l.holder} · listed {l.listedAgo}</span>
                </div>
                <div className={s.listingRight}>
                  <span className={s.price}>{l.priceNear} NEAR</span>
                  <TextButton href="#/buy">Review</TextButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </RuledSection>
    </main>
  );
}

export function MySeat() {
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Your seat</p>
        <h1>
          Seat <span className={s.seatBig}>{ME.seatNumber}</span>
        </h1>
        <p className={s.lede}>
          Held by {ME.name} since {ME.heldSince}. {ME.votesCast} votes cast. Tier: {ME.tier}.
        </p>
      </header>

      <RuledSection title="Your delegate">
        <dl className={s.facts}>
          <Fact label="Status">Voting from your brief</Fact>
          <Fact label="Brief fingerprint">
            <span className="mono">{ME.briefHash.slice(0, 16)}…</span>
          </Fact>
          <Fact label="Open proposals needing a vote">
            {OPEN_PROPOSALS.filter((p) => p.pending !== false).length}
          </Fact>
        </dl>
        <div className={s.actions}>
          <GraphicButton glyph="seat" onClick={() => { location.hash = "#/vote"; }}>
            Review your delegate's vote
          </GraphicButton>
          <TextButton href="#/brief">Edit your brief</TextButton>
        </div>
      </RuledSection>

      <RuledSection title="Open proposals">
        <ul className={s.proposals}>
          {OPEN_PROPOSALS.map((p) => (
            <li key={p.id} className={s.proposal}>
              <div>
                <a className={s.proposalTitle} href="#/vote">
                  {p.title}
                </a>
                <span className={s.muted}>
                  {" "}· {p.kind} · {p.amount} · submitted {p.submitted}
                </span>
              </div>
              {p.pending === false ? (
                <CastStatus />
              ) : (
                <PendingStatus deadline={PENDING_VOTE.deadlineClock} countdown={PENDING_VOTE.countdown} />
              )}
            </li>
          ))}
        </ul>
      </RuledSection>

      <RuledSection
        title="Club vault"
        aside={<TextButton href="#/vault">Open the vault</TextButton>}
      >
        <p className={s.muted}>Encrypted content, opened only for current seat holders.</p>
      </RuledSection>
    </main>
  );
}

export function DelegateBrief() {
  const run = useMockRun();
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Seat {ME.seatNumber}</p>
        <h1>Your delegate's brief</h1>
        <p className={s.lede}>
          Your delegate reads each proposal and prepares a vote from this brief. You can override
          any vote before it is cast.
        </p>
      </header>

      <RuledSection title="The brief">
        <label className={s.srLabel} htmlFor="brief">Brief</label>
        <textarea
          id="brief"
          className={s.briefInput}
          rows={5}
          defaultValue={"Back community events. Reject any spend over 50 NEAR. Prefer proposals that include a written reason."}
        />
        <p className={s.sample}>
          Try: <em>"Back community events. Reject any spend over 50 NEAR."</em>
        </p>
        <p className={s.note}>
          Your brief stays off-chain. Only its fingerprint is on-chain.
        </p>
        <dl className={s.facts}>
          <Fact label="Fingerprint on-chain">
            <span className="mono">{ME.briefHash}</span>
          </Fact>
        </dl>
        <div className={s.actions}>
          <GraphicButton glyph="keys" onClick={run.start}>
            Save brief
          </GraphicButton>
          {run.state === "loading" && <LoadingStatus>Saving your brief…</LoadingStatus>}
          {run.state === "success" && <SuccessStatus>Brief saved. Your delegate uses it from the next proposal.</SuccessStatus>}
          {run.state === "error" && <ErrorStatus onRetry={run.start}>The brief wasn't saved. Your last version is still in place.</ErrorStatus>}
        </div>
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

export function ProposalVote({ closed = false }: { closed?: boolean }) {
  const run = useMockRun({ ms: 1200 });
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Proposal {PENDING_VOTE.proposalId}</p>
        <h1>{PENDING_VOTE.proposalTitle}</h1>
        <dl className={s.facts}>
          <Fact label="Kind">{PENDING_VOTE.kind}</Fact>
          <Fact label="Amount">
            <span className="mono">{PENDING_VOTE.amount}</span>
          </Fact>
          <Fact label="To">
            <span className="mono">{PENDING_VOTE.to}</span>
          </Fact>
        </dl>
      </header>

      <RuledSection title="Your delegate's vote">
        <div className={s.voteCard}>
          <div className={s.voteChoice}>
            <span className={`${s.voteWord} ${s.voteApprove}`}>Approve</span>
            {closed ? (
              <CastStatus />
            ) : (
              <PendingStatus deadline={PENDING_VOTE.deadlineClock} countdown={PENDING_VOTE.countdown} />
            )}
          </div>
          <p className={s.reason}>{PENDING_VOTE.delegateReason}</p>
          {closed ? (
            <WindowBar deadline={PENDING_VOTE.deadlineClock} countdown="0:00" fraction={0} />
          ) : (
            <WindowBar deadline={PENDING_VOTE.deadlineClock} countdown={PENDING_VOTE.countdown} fraction={0.72} />
          )}
        </div>
      </RuledSection>

      {closed ? (
        <RuledSection title="Window closed">
          <div role="status" aria-live="polite">
            <span className="sr-only">Window closed. Vote cast.</span>
          </div>
          <p className={s.muted}>
            The window closed at {PENDING_VOTE.deadlineClock}. The vote was cast under your seat's voter
            account and can't be changed now.
          </p>
          <p className={s.muted}>Result: waiting for the DAO's voting period to end.</p>
          <div className={s.actions}>
            <TextButton href="#/receipt/vote">View the receipt</TextButton>
          </div>
        </RuledSection>
      ) : (
        <>
          <RuledSection title="Override before it is cast">
            <p className={s.muted}>
              The window closes at {PENDING_VOTE.deadlineClock}. After that, the vote is cast and
              cannot be changed.
            </p>
            <div className={s.actions}>
              <GraphicButton glyph="stamp" onClick={run.start}>
                Change to Reject
              </GraphicButton>
              {run.state === "loading" && <LoadingStatus>Recording your override inside the window…</LoadingStatus>}
              {run.state === "success" && (
                <SuccessStatus>Overridden by you. The vote is cast at {PENDING_VOTE.deadlineClock}.</SuccessStatus>
              )}
              {run.state === "error" && (
                <ErrorStatus onRetry={run.start}>The override didn't reach the chain. Your delegate's Approve still stands.</ErrorStatus>
              )}
            </div>
          </RuledSection>

          <RuledSection title="After the window">
            <p className={s.muted}>
              The bar locks, the override button goes away, and a status line reads when the window
              closed. The vote is then cast under your seat's voter account.
            </p>
            <div className={s.voteClosed} role="status" aria-live="polite">
              <span className="sr-only">Vote cast</span>
              <CastStatus />
              <span className={s.muted}> · cast at 14:32</span>
              <ResultStamp result="Rejected" />
            </div>
            <p className={s.muted}>
              The override window closed at {PENDING_VOTE.deadlineClock}. Example on this club:
              proposal 8 recorded Reject at 13:08 under the voter account.
            </p>
          </RuledSection>
        </>
      )}
    </main>
  );
}

export function AIReceiptPage() {
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Receipt · proposal {PENDING_VOTE.proposalId}</p>
        <h1>AI vote receipt</h1>
        <CheckedStamp />
      </header>

      <RuledSection title="What was signed">
        <dl className={s.facts}>
          <Fact label="Model">
            <span className="mono">{AI_RECEIPT.model}</span>
          </Fact>
          <Fact label="Signer">
            <span className="mono">{AI_RECEIPT.signer}</span>
          </Fact>
          <Fact label="Request hash">
            <span className="mono">{AI_RECEIPT.requestHash.slice(0, 20)}…</span>
          </Fact>
          <Fact label="Response hash">
            <span className="mono">{AI_RECEIPT.responseHash.slice(0, 20)}…</span>
          </Fact>
          <Fact label="On-chain check">
            <a className={s.txLink} href={`${EXPLORER}/tx/${AI_RECEIPT.checkTx}`} target="_blank" rel="noreferrer">
              {AI_RECEIPT.checkTx.slice(0, 8)}… <Icon name="external" size={11} />
            </a>
          </Fact>
        </dl>
      </RuledSection>

      <RuledSection title="Hardware attestation">
        <p>{AI_RECEIPT.hardwareLine}.</p>
        <ul className={s.evidence}>
          {AI_RECEIPT.evidence.map((e) => (
            <li key={e.label}>
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.label} <Icon name="external" size={12} />
              </a>
            </li>
          ))}
        </ul>
        <p className={s.muted}>
          The vote and reason come from the signed answer. The contract rebuilds the signed text,
          recovers the signer, and checks it against the club's registered model signer.
        </p>
      </RuledSection>

      <RuledSection title="Full receipt">
        <ReceiptSteps
          steps={[
            { label: "Delegate read proposal 12 inside secure hardware", tx: AI_RECEIPT.checkTx },
            { label: "NEAR AI signed the response" },
            { label: "Seat voter checked the signature on-chain", tx: AI_RECEIPT.checkTx },
            { label: "Vote stored as pending" },
          ]}
        />
      </RuledSection>
    </main>
  );
}

export function VaultPage() {
  const run = useMockRun();
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Seat {ME.seatNumber}</p>
        <h1>{VAULT.title}</h1>
      </header>

      <RuledSection inset>
        <div className={s.vaultBox}>
          <p className={s.vaultIcon} aria-hidden="true">
            <Icon name="vault" size={40} />
          </p>
          <GraphicButton glyph="vault" onClick={run.start}>
            Open the vault
          </GraphicButton>
          {run.state === "loading" && <LoadingStatus>Checking your seat inside secure hardware…</LoadingStatus>}
          {run.state === "success" && (
            <SuccessStatus>
              Vault opened. <TextButton href="#/receipt/vault">View the receipt</TextButton>
            </SuccessStatus>
          )}
          {run.state === "error" && <ErrorStatus onRetry={run.start}>The check didn't finish. Nothing was opened.</ErrorStatus>}
        </div>
      </RuledSection>

      <RuledSection title="After opening">
        <h3 className={s.vaultDocTitle}>{VAULT.content.heading}</h3>
        <p>{VAULT.content.body}</p>
        <p className={s.muted}>
          The content comes back encrypted to your own key. It is never stored on-chain in plain
          text.
        </p>
      </RuledSection>

      <RuledSection title="If you are not a holder">
        <p>
          <RefusedStamp>Not allowed</RefusedStamp>{" "}
          <span className={s.muted}>Only current seat holders can open the vault.</span>
        </p>
      </RuledSection>
    </main>
  );
}

export function SellSeat() {
  const run = useMockRun();
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Seat {ME.seatNumber}</p>
        <h1>Sell your seat</h1>
        <p className={s.lede}>
          The club decides who buys in. If the sale is approved, it completes in one flow.
        </p>
      </header>

      <RuledSection title="Set a price">
        <label className={s.fieldLabel} htmlFor="price">
          Price in NEAR
        </label>
        <input
          id="price"
          className={s.priceInput}
          inputMode="decimal"
          defaultValue={SALE.priceNear}
        />
        <MoneySplit price={SALE.priceNear} sellerPct={SALE.sellerGets} levyPct={SALE.levy} />
        <p className={s.muted}>The 95/5 split is fixed by the club. You see it before signing.</p>
      </RuledSection>

      <RuledSection title="What ends when the sale completes">
        <ul className={s.gives}>
          <li>Your vote in the club's DAO</li>
          <li>Your vault access</li>
          <li>Your delegate and its brief</li>
          <li>Your delegate's signing key</li>
        </ul>
        <p className={s.muted}>
          The seat keeps its history. The buyer's vote weight starts at 1.
        </p>
      </RuledSection>

      <RuledSection title="Waiting for the club">
        <dl className={s.facts}>
          <Fact label="Approval expires">{SALE.approvalExpires}</Fact>
          <Fact label="Votes for">{SALE.tally.for}</Fact>
          <Fact label="Votes against">{SALE.tally.against}</Fact>
          <Fact label="Threshold">{SALE.tally.threshold}</Fact>
        </dl>
        <div className={s.actions}>
          <GraphicButton glyph="padlock" onClick={run.start}>
            List seat {ME.seatNumber}
          </GraphicButton>
          {run.state === "loading" && <LoadingStatus>Listing seat {ME.seatNumber} for the club to see…</LoadingStatus>}
          {run.state === "success" && <SuccessStatus>Listed. Waiting for a buyer and the club's vote.</SuccessStatus>}
          {run.state === "error" && <ErrorStatus onRetry={run.start}>The listing wasn't posted. Your seat is still yours.</ErrorStatus>}
          <TextButton onClick={() => { location.hash = "#/seat"; }}>Cancel listing</TextButton>
        </div>
      </RuledSection>
    </main>
  );
}

export function BuySeat() {
  const l = LISTINGS[0];
  const run = useMockRun();
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Seat for sale</p>
        <h1>
          Seat <span className={s.seatBig}>{l.seat}</span>
        </h1>
        <p className={s.lede}>
          Currently held by {l.holder}. Listed {l.listedAgo}.
        </p>
      </header>

      <RuledSection title="What this seat gives">
        <ul className={s.gives}>
          <li>One vote in the club's Sputnik DAO</li>
          <li>Access to the club vault</li>
          <li>A delegate you configure with your own brief</li>
        </ul>
      </RuledSection>

      <RuledSection title="Price and split">
        <MoneySplit price={l.priceNear} sellerPct={split(l.priceNear).seller} levyPct={split(l.priceNear).levy} />
      </RuledSection>

      <RuledSection title="Seat history">
        <ul className={s.history}>
          {l.history.map((h) => (
            <li key={h.event}>
              <span>{h.event}</span>
              <span className={s.muted}>{h.date}</span>
            </li>
          ))}
        </ul>
      </RuledSection>

      <RuledSection title="Buy with club approval">
        <p className={s.muted}>
          Your payment is escrowed while the club votes. On approval the seat moves, the seller is
          paid, the levy goes to the treasury, and your vote weight starts at 1. On rejection or
          timeout you are refunded in full.
        </p>
        <div className={s.actions}>
          <GraphicButton glyph="padlock" onClick={run.start}>
            Buy seat {l.seat} for {l.priceNear} NEAR
          </GraphicButton>
          {run.state === "loading" && <LoadingStatus>Escrowing {l.priceNear} NEAR…</LoadingStatus>}
          {run.state === "success" && <SuccessStatus>Escrowed. The club is reviewing your offer.</SuccessStatus>}
          {run.state === "error" && <ErrorStatus onRetry={run.start}>The payment wasn't escrowed. Nothing was charged.</ErrorStatus>}
        </div>
      </RuledSection>
    </main>
  );
}

function split(price: string) {
  const n = Number(price);
  return { seller: (n * 0.95).toFixed(3), levy: (n * 0.05).toFixed(3) };
}

function saleSteps(seat: string, price: string, seller: string, levy: string) {
  return [
    { label: "Club approved the sale", tx: SALE_TX_APPROVE },
    { label: `Buyer escrowed ${price} NEAR`, tx: SALE_TX_BUY },
    { label: `Seat ${seat} moved; seller paid ${seller} NEAR; levy ${levy} NEAR to the treasury`, tx: SALE_TX_BUY },
  ];
}

export function ReceiptPage({ kind }: { kind: "vote" | "sale" | "buy" | "vault" }) {
  const l = LISTINGS[0];
  const data =
    kind === "sale"
      ? {
          title: "Sale approved",
          sub: `Seat ${SALE.seat} · ${SALE.priceNear} NEAR`,
          steps: saleSteps(SALE.seat, SALE.priceNear, SALE.sellerGets, SALE.levy),
        }
      : kind === "buy"
        ? {
            title: "Purchase approved",
            sub: `Seat ${l.seat} · ${l.priceNear} NEAR`,
            steps: saleSteps(l.seat, l.priceNear, split(l.priceNear).seller, split(l.priceNear).levy),
          }
        : kind === "vault"
          ? {
              title: "Vault opened",
              sub: `Seat ${ME.seatNumber} · content encrypted to your key`,
              steps: [
                { label: "Seat ownership checked inside secure hardware", tx: "FU8ffdZWiJBW6VXBrhYVcgGXhpst2LCtGSbdwaJCM7a7" },
                { label: "Vault content encrypted to your key", tx: "BxBCX7X71Ci9itiuaoD9UXXM7Lx8uakq6KscMkiEmPNH" },
              ],
            }
          : {
              title: "Vote overridden",
              sub: `Proposal ${PENDING_VOTE.proposalId} · Reject`,
              steps: [
                { label: "Delegate prepared Approve", tx: AI_RECEIPT.checkTx },
                { label: "You overrode to Reject inside the window", tx: "8UJ9FTgsQauPy6rZK8LhMp4ihXy4BWyLkwsx344tTypR" },
                { label: "Vote cast under your voter account", tx: "GbQe2qZdswMHhAFWKEq4eGSJ9948KaR6TWWsCKsdsFP4" },
              ],
            };
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Receipt</p>
        <h1>{data.title}</h1>
        <p className={s.lede}>{data.sub}</p>
        <CheckedStamp />
      </header>
      <RuledSection title="On-chain steps">
        <ReceiptSteps steps={data.steps} />
      </RuledSection>
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
      {run.state === "loading" && <LoadingStatus>Checking your seat inside secure hardware…</LoadingStatus>}
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
            <TextButton>Apply for a seat</TextButton>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Seat held, no brief</span>
            <span className={s.edgeDemo}>
              <span className={s.muted}>Your seat is held. Your delegate can't vote until you write a brief.</span>
              <TextButton href="#/brief">Write your brief</TextButton>
            </span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Brief set, no open proposals</span>
            <span className={s.muted}>Your brief is saved. No proposal needs a vote right now.</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Delegate thinking</span>
            <span className={s.muted}>Your delegate is reading proposal 12 inside secure hardware…</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Offer waiting for club</span>
            <span className={s.muted}>The club is reviewing your offer. Your funds stay in escrow and come back if it's declined or expires.</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Vault checking</span>
            <span className={s.muted}>Checking your seat inside secure hardware…</span>
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
            <span className={s.muted}>Your delegate is reading proposal 8 inside secure hardware…</span>
          </li>
          <li className={s.stateRow}>
            <span className={s.stateName}>Wallet not connected</span>
            <TextButton>Connect wallet</TextButton>
          </li>
        </ul>
      </RuledSection>
    </main>
  );
}
