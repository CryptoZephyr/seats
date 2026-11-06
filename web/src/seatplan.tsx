import { MEMBERS } from "./data";
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

function seatPositions() {
  const seats: { x: number; y: number; rot: number }[] = [];
  for (const row of ROWS) {
    for (let i = 0; i < row.count; i++) {
      const t = row.count === 1 ? 0.5 : i / (row.count - 1);
      const angle = row.from + t * (row.to - row.from);
      const rad = (angle * Math.PI) / 180;
      seats.push({
        x: CX + row.radius * Math.cos(rad),
        y: CY - row.radius * Math.sin(rad),
        rot: angle - 90,
      });
    }
  }
  return seats;
}

const POSITIONS = seatPositions();

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

export function SeatPlan() {
  const held = MEMBERS.filter((m) => m.state === "held").length;
  return (
    <>
      <svg
        viewBox="0 0 500 250"
        role="img"
        aria-label={`Hemicycle seat plan, ${held} of ${MEMBERS.length} seats held`}
        className={styles.plan}
      >
        {POSITIONS.map((p, i) => {
          const m = MEMBERS[i];
          if (!m) return null;
          const isHeld = m.state === "held";
          const isMine = m.name === "Ada";
          const cls = [styles.seat, isHeld ? styles.seatHeld : styles.seatEmpty, isMine ? styles.seatMine : ""].join(" ");
          return (
            <g key={m.seat} transform={`translate(${p.x} ${p.y})`}>
              <rect x={-15} y={-15} width={30} height={30} className={cls} transform={`rotate(${p.rot})`} />
              <text x={0} y={4} textAnchor="middle" className={styles.seatNumber}>
                {m.seat}
              </text>
              {isHeld && m.mark && (
                <g transform="translate(0 -22)" className={styles.mark}>
                  {markShape(m.mark)}
                </g>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="sr-only">
        {MEMBERS.map((m) => (
          <li key={m.seat}>
            Seat {m.seat}, {m.state === "held" ? "held" : "open"}
            {m.state === "held" && m.mark ? `, voted ${VOTE_WORD[m.mark]}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}
