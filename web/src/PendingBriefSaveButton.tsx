import { GraphicButton } from "./ui";

export const PENDING_BRIEF_SAVE_LABEL = "Save fingerprint on-chain (0.1 NEAR storage)";

export function PendingBriefSaveButton({
  onClick,
  disabled,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <GraphicButton glyph="keys" onClick={onClick} disabled={disabled}>
      {PENDING_BRIEF_SAVE_LABEL}
    </GraphicButton>
  );
}
