const proposalDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const proposalDateTooltipFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

export function formatProposalDate(timestampNs: string | bigint) {
  const date = new Date(Number(BigInt(timestampNs) / 1_000_000n));
  const parts = proposalDateFormatter.formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return {
    text: proposalDateFormatter.format(date),
    tooltip: proposalDateTooltipFormatter.format(date),
    datetime: date.toISOString(),
    time: `${hour}:${minute}`,
  };
}
