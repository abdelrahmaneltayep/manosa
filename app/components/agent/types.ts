/**
 * The Buyer Agent's three admin screens, as plain serialisable data.
 *
 * Same rule as everywhere else in this app: the component is handed sentences
 * and booleans, never a Prisma row and never a `Date`. That is what makes the
 * state captures possible in an environment where the embedded admin cannot
 * be driven, and it keeps the decisions — which chip, which warning, which
 * checklist item is outstanding — in modules a test can reach.
 */

export interface PublishItemView {
  /** "rule" | "buyer" | "reviewed" | "test" — a catalog key, not a sentence. */
  step: string;
  done: boolean;
  href: string;
}

export interface PublishView {
  items: PublishItemView[];
  ready: boolean;
  published: boolean;
  /**
   * Whether we have seen the theme app embed actually serve a buyer.
   *
   * "Published" is our switch; the embed is the merchant's, in the theme
   * editor. Saying "the agent is live" without this is a claim about somebody
   * else's theme that this app cannot make.
   */
  embedLive: boolean;
  embedAttested: boolean;
  /** Where a buyer meets it. Null when the shop's domain is not known yet. */
  storefrontUrl: string | null;
  /** True on the request that just published, for the confirmation. */
  justPublished: boolean;
  /** Set when a publish was refused because something is outstanding. */
  refused: string[];
}

export interface AbilityView {
  /** "canBuildCart" and friends. */
  key: string;
  on: boolean;
}

export interface LintWarningView {
  /** A catalog key, so the warning is in the merchant's language. */
  key: string;
  phrase: string;
}

export interface TestBuyerView {
  customerId: string;
  name: string;
}

export interface GuardrailsView {
  entitled: boolean;
  requiredPlan: string | null;
  publish: PublishView;
  abilities: AbilityView[];
  guestMode: boolean;
  tone: string;
  tones: string[];
  customInstructions: string;
  words: number;
  maxWords: number;
  warnings: LintWarningView[];
  offLimits: string[];
  /** The merchant has said they read these. The checklist's third item. */
  reviewed: boolean;
  /** Shown after a save, so the merchant knows it took. */
  saved: boolean;
  /** Field and reason, beside the field, never auto-dismissed. */
  error: { field: string; code: string } | null;
}

/* -------------------------------------------------------------------------- */

export interface TestTurnView {
  role: "BUYER" | "AGENT" | "MERCHANT";
  text: string;
  /** The stored code, for tests and for the raw record. */
  refusal: string | null;
  /** The same thing as a sentence, in the merchant's language. */
  refusalLabel: string;
  tool: string | null;
}

export interface TestCartLineView {
  title: string;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  rule: string | null;
}

export interface TestView {
  entitled: boolean;
  requiredPlan: string | null;
  /** Approved buyers whose context the merchant may rehearse against. */
  buyers: TestBuyerView[];
  buyerId: string | null;
  /** The merchant asked for a buyer this shop cannot rehearse as. */
  buyerNotFound: boolean;
  /** What narrowed the picker, echoed back. */
  search: string;
  turns: TestTurnView[];
  cart: { lines: TestCartLineView[]; subtotal: string } | null;
  /** Why the last turn could not be answered. */
  failure: string | null;
  /** No `ANTHROPIC_API_KEY`: the panel says so instead of pretending. */
  noKey: boolean;
  /** A rehearsal the agent answered has happened at least once. */
  completed: boolean;
}

/* -------------------------------------------------------------------------- */

export interface LogRowView {
  id: string;
  buyer: string;
  when: string;
  /** The machine-readable time, for `<s-text>`'s title and for sorting tests. */
  at: string;
  outcome: string;
  turns: number;
  testMode: boolean;
  takenOver: boolean;
}

export interface LogView {
  rows: LogRowView[];
  page: number;
  pageCount: number;
  total: number;
  /** This shop has never had a conversation at all — a different empty state. */
  neverAny: boolean;
  published: boolean;
  filters: { outcome: string; search: string };
  outcomes: string[];
  entitled: boolean;
  requiredPlan: string | null;
  retentionDays: number;
}

export interface TranscriptTurnView {
  id: string;
  role: "BUYER" | "AGENT" | "MERCHANT";
  text: string;
  when: string;
  at: string;
  /** Why the agent refused or failed. The log's whole reason for existing. */
  refusal: string | null;
  /** The same thing as a sentence, in the merchant's language. */
  refusalLabel: string;
  /** True for the row that records a person joining the conversation. */
  joined: boolean;
  /** Which tool ran, and what it computed — "why did it say that?". */
  tool: string | null;
  facts: string[];
}

export interface TranscriptView {
  id: string;
  buyer: string;
  startedAt: string;
  outcome: string;
  testMode: boolean;
  takenOver: boolean;
  takenOverWhen: string | null;
  turns: TranscriptTurnView[];
  /** Set after the merchant's own message went in. */
  sent: boolean;
  /** The reply was longer than `MAX_REPLY_CHARS` and was not sent. */
  tooLong: boolean;
  maxReplyChars: number;
  entitled: boolean;
}
