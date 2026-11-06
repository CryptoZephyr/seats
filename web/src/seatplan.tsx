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
  mark?: VoteKind;
}

export function SeatPlan({
  seats,
  viewerAccountId,
}: {
  seats: SeatPlanSeat[];
  viewerAccountId: string | null;
}) {
  const positions = seatPositions(seats.length);
  return (
    <>
      <svg
        viewBox="0 0 500 250"
        role="img"
        aria-label={`Hemicycle seat plan, ${seats.length} ${
          seats.length === 1 ? "seat" : "seats"
        } held`}
        className={styles.plan}
      >
        {positions.map((p, i) => {
          const seat = seats[i];
          const isMine = seat.ownerId === viewerAccountId;
          const cls = [styles.seat, styles.seatHeld, isMine ? styles.seatMine : ""].join(" ");
          return (
            <g key={seat.seat} transform={`translate(${p.x} ${p.y})`}>
              <rect x={-15} y={-15} width={30} height={30} className={cls} transform={`rotate(${p.rot})`} />
              <text x={0} y={4} textAnchor="middle" className={styles.seatNumber}>
                {seat.seat}
              </text>
              {seat.mark && (
                <g transform="translate(0 -22)" className={styles.mark}>
                  {markShape(seat.mark)}
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
            {seat.mark ? `, voted ${VOTE_WORD[seat.mark]}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}
