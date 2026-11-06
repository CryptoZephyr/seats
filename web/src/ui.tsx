import type { CSSProperties, ReactNode } from "react";
import { Button } from "react-aria-components";
import { useViewer } from "./chain/WalletProvider";
import styles from "./ui.module.css";
import arrowRaw from "./assets/icons/arrow.svg?raw";
import externalRaw from "./assets/icons/external.svg?raw";
import lockRaw from "./assets/icons/lock.svg?raw";
import clockRaw from "./assets/icons/clock.svg?raw";
import walletRaw from "./assets/icons/wallet.svg?raw";
import keysRaw from "./assets/icons/keys.svg?raw";
import stampRaw from "./assets/icons/stamp.svg?raw";
import ticketRaw from "./assets/icons/ticket.svg?raw";
import vaultRaw from "./assets/icons/vault.svg?raw";

const ICONS: Record<string, string> = {
  arrow: arrowRaw,
  external: externalRaw,
  lock: lockRaw,
  clock: clockRaw,
  wallet: walletRaw,
  keys: keysRaw,
  stamp: stampRaw,
  ticket: ticketRaw,
  vault: vaultRaw,
};

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <span
      className={styles.icon}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

export function TestnetStrip() {
  return <div className={styles.testnet}>NEAR TESTNET</div>;
}

export function SiteHeader() {
  const viewer = useViewer();
  return (
    <header className={styles.header}>
      <a className={styles.brand} href="#/club" aria-label="Seats home">
        <img src="/brand/seats-logo-ui.png" alt="" className={styles.logo} />
        <span className={styles.wordmark}>Seats</span>
      </a>
      <nav className={styles.nav} aria-label="Primary">
        <a href="#/club">Club</a>
        <a href="#/seat">My seat</a>
        <a href="#/docs">Docs</a>
        {viewer.accountId ? (
          <button
            type="button"
            className={styles.textButton}
            onClick={() => void viewer.signOut()}
            disabled={!viewer.walletReady}
          >
            Sign out
          </button>
        ) : (
          <button
            type="button"
            className={styles.textButton}
            onClick={viewer.signIn}
            disabled={!viewer.walletReady}
          >
            Sign in
          </button>
        )}
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerStage}>
        <img src="/brand/seats-silhouette-cutout.png" alt="Seats" className={styles.footerMark} />
      </div>
      <div className={styles.floor} aria-hidden="true" />
      <div className={styles.footerRow}>
        <span className={styles.footerTag}>NEAR TESTNET</span>
        <p className={styles.footerLine}>Seats: memberships you can sell, with the club's approval.</p>
        <nav className={styles.footerNav} aria-label="Footer">
          <a href="#/club">Club</a>
          <a href="#/seat">My seat</a>
          <a href="#/docs">Docs</a>
          <a href="#/policy">Policy</a>
          <a href="#/license">License</a>
        </nav>
      </div>
    </footer>
  );
}

export type GlyphName = "seat" | "vault" | "stamp" | "padlock" | "ticket" | "arrow" | "keys";

function Glyph({ name }: { name: GlyphName }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "square" as const,
  };
  switch (name) {
    case "seat":
      return (
        <svg {...common} aria-hidden="true">
          <rect className={styles.glyphFill} x="8" y="13" width="9" height="5" fill="currentColor" stroke="none" />
          <path d="M7 3v9" />
          <path d="M7 12h11" />
          <path d="M18 12v8" />
          <path d="M5 20h15" />
        </svg>
      );
    case "vault":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="3" y="2" width="18" height="20" />
          <g className={styles.glyphDoor}>
            <rect x="6" y="5" width="9" height="14" />
            <circle cx="10.5" cy="12" r="2.4" />
            <path d="M10.5 10.2v-1.4M10.5 13.8v1.4M8.7 12H7.4M12.3 12h1.3" />
          </g>
        </svg>
      );
    case "stamp":
      return (
        <svg {...common} aria-hidden="true">
          <path d="M5 19h14" />
          <g className={styles.glyphHead}>
            <path d="M9 3h6v4H9z" />
            <path d="M7 7h10v7H7z" />
            <path d="M10 10.5h4" />
          </g>
        </svg>
      );
    case "padlock":
      return (
        <svg {...common} aria-hidden="true">
          <rect x="5" y="10" width="14" height="10" />
          <g className={styles.glyphShackle}>
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </g>
          <circle cx="12" cy="14.5" r="1.6" fill="currentColor" stroke="none" />
          <path d="M12 15.8v2.2" />
        </svg>
      );
    case "ticket":
      return (
        <svg {...common} aria-hidden="true">
          <g className={styles.glyphSlide}>
            <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z" />
            <path d="M14 6v12" strokeDasharray="2 3" />
          </g>
        </svg>
      );
    case "keys":
      return (
        <svg {...common} aria-hidden="true">
          <g className={styles.glyphKey}>
            <circle cx="8" cy="12" r="4" />
            <path d="M12 12h9M17 12v3.5M20 12v2.5" />
          </g>
          <circle cx="19" cy="7" r="1.6" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...common} aria-hidden="true">
          <g className={styles.glyphSlide}>
            <path d="M4 12h15M13 6l6 6-6 6" />
          </g>
        </svg>
      );
  }
}

export function GraphicButton({
  glyph,
  children,
  onClick,
}: {
  glyph: GlyphName;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Button className={styles.graphicButton} onPress={onClick}>
      <span className={styles.graphicGlyph} data-glyph={glyph} aria-hidden="true">
        <Glyph name={glyph} />
      </span>
      <span>{children}</span>
    </Button>
  );
}

export function TextButton({
  children,
  onClick,
  href,
}: {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
}) {
  if (href) {
    return (
      <a className={styles.textButton} href={href}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" className={styles.textButton} onClick={onClick}>
      {children}
    </button>
  );
}

export function RuledSection({
  title,
  aside,
  children,
  inset,
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  inset?: boolean;
}) {
  return (
    <section className={`${styles.ruled} ${inset ? styles.ruledInset : ""}`}>
      {(title || aside) && (
        <div className={styles.ruledHead}>
          {title && <h2 className={styles.ruledTitle}>{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function LoadingStatus({ children }: { children: ReactNode }) {
  return (
    <p className={styles.loading} role="status" aria-live="polite">
      <span className={styles.loadingSeats} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{children}</span>
    </p>
  );
}

export function SuccessStatus({ children }: { children: ReactNode }) {
  return (
    <p className={styles.successStatus} role="status" aria-live="polite">
      <svg viewBox="0 0 16 16" className={styles.successTick} aria-hidden="true">
        <path d="M2.5 8.5L6.5 12.5L13.5 4" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

export function ErrorStatus({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className={styles.errorStatus} role="alert">
      <span className={styles.errorWord}>Not completed</span>
      <span>{children}</span>
      {onRetry && <TextButton onClick={onRetry}>Try again</TextButton>}
    </div>
  );
}

export function PendingStatus({ deadline, countdown }: { deadline: string; countdown: string }) {
  return (
    <span className={styles.statusPending} role="status" aria-live="polite">
      <span className={styles.statusWord}>Pending</span>
      <span className={styles.drainBar} aria-hidden="true">
        <span className={styles.drainFill} />
      </span>
      <span className={styles.statusMeta}>
        Closes at {deadline} · {countdown} left
      </span>
    </span>
  );
}

export function OverriddenStatus() {
  return (
    <span className={styles.statusOverridden}>
      <span className={styles.solidSquare} aria-hidden="true" />
      Overridden by you
    </span>
  );
}

export function CastStatus() {
  return (
    <span className={styles.statusCast} role="status" aria-live="polite">
      <Icon name="lock" size={14} />
      Cast
    </span>
  );
}

export function ResultStamp({ result }: { result: "Approved" | "Rejected" | "Expired" }) {
  const cls =
    result === "Approved"
      ? styles.resultApproved
      : result === "Rejected"
        ? styles.resultRejected
        : styles.resultExpired;
  const tick = result === "Approved";
  return (
    <span className={`${styles.resultStamp} ${cls}`} role="status" aria-live="polite">
      {tick && <span aria-hidden="true">✓ </span>}
      {result}
    </span>
  );
}

export function RefusedStamp({ children }: { children: ReactNode }) {
  return <span className={styles.refusedStamp}>{children}</span>;
}

export function CheckedStamp() {
  return (
    <span className={styles.checkedStamp}>
      <span className={styles.ringStamp} aria-hidden="true" />
      Checked on-chain
    </span>
  );
}

export function WindowBar({ deadline, countdown, fraction }: { deadline: string; countdown: string; fraction: number }) {
  const pct = `${Math.round(fraction * 100)}%`;
  return (
    <div className={styles.windowBar} role="timer" aria-label={`Override window closes at ${deadline}, ${countdown} left`}>
      <div className={styles.windowTrack}>
        <div className={styles.windowFill} style={{ "--window-pct": pct } as CSSProperties} />
      </div>
      <p className={styles.windowText}>
        Closes at <span className={styles.monoInline}>{deadline}</span> ·{" "}
        <span className={styles.monoInline}>{countdown}</span> left
      </p>
    </div>
  );
}

export function MoneySplit({ price, sellerPct, levyPct }: { price: string; sellerPct: string; levyPct: string }) {
  return (
    <dl className={styles.moneySplit}>
      <div className={styles.moneyRow}>
        <dt>Price</dt>
        <dd>{price} NEAR</dd>
      </div>
      <div className={styles.moneyRow}>
        <dt>To the seller</dt>
        <dd>{sellerPct} NEAR</dd>
      </div>
      <div className={styles.moneyRow}>
        <dt>Club levy</dt>
        <dd>{levyPct} NEAR</dd>
      </div>
    </dl>
  );
}

export function ReceiptSteps({ steps }: { steps: { label: string; tx?: string }[] }) {
  return (
    <ol className={styles.receiptSteps}>
      {steps.map((step) => (
        <li key={step.label} className={styles.receiptStep}>
          <span className={styles.receiptLabel}>{step.label}</span>
          {step.tx && (
            <a
              className={`${styles.receiptTx} mono`}
              href={`https://testnet.nearblocks.io/tx/${step.tx}`}
              target="_blank"
              rel="noreferrer"
            >
              {step.tx.slice(0, 8)}…{step.tx.slice(-6)}
              <span className={styles.srOnly}> (opens explorer)</span>
              <Icon name="external" size={12} />
            </a>
          )}
        </li>
      ))}
    </ol>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
