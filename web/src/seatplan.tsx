import styles from "./seatplan.module.css";

export type VoteKind = "tick" | "cross" | "ring";

export const VOTE_WORD: Record<VoteKind, string> = { tick: "Approve", cross: "Reject", ring: "Abstain" };

const CX = 250;
const CY = 250;

const ROWS = [
  { radius: 210, count: 5, from: 172, to: 8 },
  { radius: 165, count: 4, from: 160, to: 20 },
  { radius: 120, count: 3, from: 148, to: 32 },
];

function seatPositions(count: number) {
  const seats: { x: number; y: number; rot: number }[] = [];
  let remaining = count;
  const addRow = (row: (typeof ROWS)[number], rowCount: number) => {
    for (let i = 0; i < rowCount; i++) {
      const t = rowCount === 1 ? 0.5 : i / (rowCount - 1);
      const angle = row.from + t * (row.to - row.from);
      const rad = (angle * Math.PI) / 180;
      seats.push({
        x: CX + row.radius * Math.cos(rad),
        y: CY - row.radius * Math.sin(rad),
        rot: angle - 90,
      });
    }
  };

  for (const row of [...ROWS].reverse()) {
    const rowCount = Math.min(remaining, row.count);
    if (rowCount === 0) break;
    addRow(row, rowCount);
    remaining -= rowCount;
  }

  let rowIndex = ROWS.length;
  while (remaining > 0) {
    const row = {
      radius: Math.max(42, 120 - (rowIndex - 2) * 24),
      count: 5,
      from: 148,
      to: 32,
    };
    const rowCount = Math.min(remaining, row.count);
    addRow(row, rowCount);
    remaining -= rowCount;
    rowIndex += 1;
  }
  return seats;
}

function markShape(kind: VoteKind) {
  switch (kind) {
    case "tick":
      return <path d="M-5 0L-1.5 3.5L5 -4" />;
    case "cross":
      return <path d="M-4 -4L4 4M4 -4L-4 4" />;
    case "ring":
      return <circle cx="0" cy="0" r="4" />;
  }
}

export function VoteMark({ kind, size = 16 }: { kind: VoteKind; size?: number }) {
  return (
    <svg viewBox="-8 -8 16 16" width={size} height={size} aria-hidden="true" className={styles.mark}>
      {markShape(kind)}
    </svg>
  );
}

export interface SeatPlanSeat {
  seat: string;
  ownerId: string;
  lastVote?: {
    kind: VoteKind;
    vote: string;
    proposalId: number;
  };
}

export function SeatPlan({
  seats,
  viewerAccountId,
}: {
  seats: SeatPlanSeat[];
  viewerAccountId: string | null;
}) {
  const positions = seatPositions(seats.length);
  const viewBox =
    seats.length === 1
      ? "160 80 180 100"
      : seats.length <= 5
        ? "70 35 360 190"
        : "0 0 500 250";
  const planClass =
    seats.length === 1
      ? styles.planSingle
      : seats.length <= 5
        ? styles.planFew
        : "";
  const seatsWithVotes = seats
    .filter((seat) => seat.lastVote)
    .map((seat) => ({ ...seat, lastVote: seat.lastVote! }));
  return (
    <>
      <svg
        viewBox={viewBox}
        role="img"
        aria-label={`Hemicycle seat plan, ${seats.length} ${
          seats.length === 1 ? "seat" : "seats"
        } held`}
        className={`${styles.plan} ${planClass}`}
      >
        {positions.map((p, i) => {
          const seat = seats[i];
          const isMine = seat.ownerId === viewerAccountId;
          const cls = [styles.seat, styles.seatHeld, isMine ? styles.seatMine : ""].join(" ");
          const voteLabel = seat.lastVote
            ? `Last vote: ${seat.lastVote.vote} on proposal ${seat.lastVote.proposalId}`
            : "";
          return (
            <g
              key={seat.seat}
              transform={`translate(${p.x} ${p.y})`}
              aria-label={`Seat ${seat.seat}${voteLabel ? `. ${voteLabel}` : ""}`}
            >
              {voteLabel && <title>{voteLabel}</title>}
              <rect x={-15} y={-15} width={30} height={30} className={cls} transform={`rotate(${p.rot})`} />
              <text x={0} y={4} textAnchor="middle" className={styles.seatNumber}>
                {seat.seat}
              </text>
              {seat.lastVote && (
                <g transform="translate(0 -22)" className={styles.mark}>
                  {markShape(seat.lastVote.kind)}
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="sr-only">
        {seats.map((seat) => (
          <li key={seat.seat}>
            Seat {seat.seat}, held by {seat.ownerId}
            {seat.lastVote
              ? `, Last vote: ${VOTE_WORD[seat.lastVote.kind]} on proposal ${seat.lastVote.proposalId}`
              : ""}
          </li>
        ))}
      </ul>
      {seatsWithVotes.length > 0 && (
        <div className={styles.voteLabels}>
          {seatsWithVotes.map((seat) => (
            <p key={seat.seat}>
              {seatsWithVotes.length > 1 && `Seat ${seat.seat}. `}
              Last vote: {VOTE_WORD[seat.lastVote.kind]} on proposal {seat.lastVote.proposalId}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
