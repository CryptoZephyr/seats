export const EXPLORER = "https://testnet.nearblocks.io";

export const CLUB = {
  name: "Civic Commons",
  dao: "seats2-1793847972.sputnikv2.testnet",
  seatContract: "seatsnft3-1793848334.testnet",
  voter: "s1.seatsnft3-1793848334.testnet",
  seatCap: 12,
  seatsHeld: 7,
  levyBps: 500,
};

export const ME = {
  name: "Ada",
  account: "rb.seatsfund1-1793846395.testnet",
  seatNumber: "2",
  heldSince: "12 Oct 2026",
  votesCast: 9,
  tier: "Member",
  briefHash: "5f8bd6496cc91e91061650ada237077e91cfd006614f8f6abb98dedaaea5475c",
  briefSaved: true,
  holdsSeat: true,
};

export const MEMBERS = [
  { seat: "1", name: "Ben", state: "held" as const, mark: "tick" as const },
  { seat: "2", name: "Ada", state: "held" as const, mark: "cross" as const },
  { seat: "3", name: "Mira", state: "held" as const, mark: "tick" as const },
  { seat: "4", name: "Jonas", state: "held" as const },
  { seat: "5", name: "Priya", state: "held" as const, mark: "ring" as const },
  { seat: "6", name: "", state: "empty" as const },
  { seat: "7", name: "Sam", state: "held" as const },
  { seat: "8", name: "", state: "empty" as const },
  { seat: "9", name: "", state: "empty" as const },
  { seat: "10", name: "", state: "empty" as const },
  { seat: "11", name: "", state: "empty" as const },
  { seat: "12", name: "", state: "empty" as const },
];

export const OPEN_PROPOSALS = [
  {
    id: 12,
    title: "Pay 12 NEAR deposit for the November venue",
    kind: "Transfer",
    amount: "12 NEAR",
    submitted: "6 Nov 2026, 13:02",
    periodEnds: "6 Nov 2026, 14:32",
    pending: true,
  },
  {
    id: 11,
    title: "Approve new member application: Theo",
    kind: "Policy",
    amount: "No payment",
    submitted: "6 Nov 2026, 08:15",
    periodEnds: "7 Nov 2026, 09:12",
    pending: false,
  },
];

export const PENDING_VOTE = {
  proposalId: 12,
  proposalTitle: "Pay 12 NEAR deposit for the November venue",
  kind: "Transfer",
  amount: "12 NEAR",
  to: "venue.civiccommons.testnet",
  delegateVote: "Approve" as const,
  delegateReason:
    "This is a small spend that supports a community event and sits well under the 50 NEAR cap.",
  deadlineClock: "14:32",
  countdown: "1:42",
  windowOpens: "13:02",
  receiptHash: "995b96f5a6652d050f7f55fc761485eef9460d64877052589801acb459008e15",
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  signer: "0xfe0071895500a9755c18044948ab4f4e1a7f337e",
  requestHash: "dadae39fe5495796639c49b381590256bb20928891686d8584a2d4402d84bae7",
  responseHash: "b3f9c2e1a7d48f60b5c9e2a1d7f48b3c6e9a2d5f8b1c4e7a0d3f6b9c2e5a8d1f4b7c",
  checkTx: "41ULmjaoKmLvuJNBFwZFuNtDCqVFvkiJJneG8i3xEaV9",
};

export const AI_RECEIPT = {
  model: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  requestHash: "dadae39fe5495796639c49b381590256bb20928891686d8584a2d4402d84bae7",
  responseHash: "b3f9c2e1a7d48f60b5c9e2a1d7f48b3c6e9a2d5f8b1c4e7a0d3f6b9c2e5a8d1f4b7c",
  signer: "0xfe0071895500a9755c18044948ab4f4e1a7f337e",
  checkTx: "41ULmjaoKmLvuJNBFwZFuNtDCqVFvkiJJneG8i3xEaV9",
  hardwareLine:
    "Verified public OS on genuine Intel and NVIDIA hardware",
  evidence: [
    { label: "TDX quote", url: `${EXPLORER}/tx/DsjFQ5HpJ66nxACGgnuMk3KuoGWqF5qGyZjGgeYE9qMY` },
    { label: "NVIDIA GPU evidence", url: `${EXPLORER}/tx/DKgbHtmu83h6sriHfXT7prr9uAM43C1xeutLyu5QoSdc` },
    { label: "OS image reproduction", url: "https://github.com/Dstack-TEE/meta-dstack/releases/tag/v0.5.12" },
  ],
};

export const RECENT_DECISIONS = [
  {
    id: 8,
    title: "Pay 80 NEAR to rent the venue for the club meetup",
    result: "Rejected" as const,
    detail: "Delegate vote: Reject. Reason: exceeds the 50 NEAR brief cap.",
    tx: "9q1NuQoV1LXGCto7CuChzWzyADuBDk4f2JJHRy8YfQ8r",
    time: "5 Nov 2026, 13:08",
  },
  {
    id: 6,
    title: "Pay 0.01 NEAR for snacks at the community meetup",
    result: "Expired" as const,
    detail: "Member overrode the delegate's Approve to Reject inside the window. The DAO marked it expired after the cast landed late.",
    tx: "GbQe2qZdswMHhAFWKEq4eGSJ9948KaR6TWWsCKsdsFP4",
    time: "5 Nov 2026, 11:52",
  },
  {
    id: 4,
    title: "Pay 80 NEAR to rent the venue for the club meetup",
    result: "Rejected" as const,
    detail: "Delegate vote Reject, cast after the window.",
    tx: "8Q6y1AQxPDXQsVnMUFxRMwfvUhnd4AGdHUWVrWrvvbRx",
    time: "5 Nov 2026, 09:14",
  },
];

export const LISTINGS = [
  {
    seat: "4",
    holder: "Jonas",
    priceNear: "2.5",
    listedAgo: "2 days ago",
    history: [
      { event: "Minted to Jonas", date: "3 Sep 2026" },
      { event: "Listed for sale", date: "3 Nov 2026" },
    ],
  },
];

export const SALE = {
  seat: "2",
  priceNear: "1.8",
  sellerGets: "1.71",
  levy: "0.09",
  buyer: "buyer-1793829831.testnet",
  approvalExpires: "7 Nov 2026, 09:14",
  tally: { for: 4, against: 1, threshold: 3 },
};

export const SALE_TX_APPROVE = "D95A7WWMX8ZjRGw6b2Fek8kj85c3RGvZSGWfEWAjznYC";
export const SALE_TX_BUY = "CHTc8EBxop8t6Z3qL3XzSDnCHBWejRxAvVKbaABFRahu";

export const VAULT = {
  title: "Club vault",
  note: "Only current seat holders can open the vault.",
  content: {
    heading: "November meetup plan",
    body: "Venue deposit paid from the treasury. Catering quote attached. Members bring one skill-share item each; sign-up sheet is in the shared doc.",
  },
};


