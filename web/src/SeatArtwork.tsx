import styles from "./SeatArtwork.module.css";

export function isAllowedSeatArtworkMedia(media: string | null | undefined): media is string {
  if (!media) return false;
  if (/^data:image\/svg\+xml(?:;|,)/i.test(media)) return true;
  try {
    return new URL(media).protocol === "https:";
  } catch {
    return false;
  }
}

export function SeatArtwork({
  seatId,
  media,
  className,
}: {
  seatId: string;
  media?: string | null;
  className?: string;
}) {
  if (!isAllowedSeatArtworkMedia(media)) return null;
  return (
    <img
      className={[styles.artwork, className].filter(Boolean).join(" ")}
      src={media}
      alt={`Seat ${seatId} artwork`}
      loading="lazy"
    />
  );
}
