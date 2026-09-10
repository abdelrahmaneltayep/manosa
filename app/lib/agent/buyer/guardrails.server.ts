import type { AgentGuardrails } from "@prisma/client";

import { db } from "~/db.server";
import { shopScope, tenant } from "~/lib/tenant/shop-context.server";

/**
 * What the merchant lets the Buyer Agent do.
 *
 * The important property is that **the model is never asked**. Every ability
 * is checked in our own code immediately before the tool that needs it runs,
 * so an agent whose `canRequestQuote` is off has no code path to a quote — not
 * a prompt telling it not to. A merchant's custom instructions are advisory
 * text passed to the model; they cannot switch an ability back on, and the lint
 * below exists to tell the merchant when they have written something that
 * reads as if it could.
 */

export const TONES = ["warm", "plain", "brief"] as const;
export type Tone = (typeof TONES)[number];

export const isTone = (value: string): value is Tone =>
  (TONES as readonly string[]).includes(value);

/** The checklist's cap: "custom instructions box (200 words max)". */
export const MAX_INSTRUCTION_WORDS = 200;

/** How long a conversation is kept. The checklist's "Retention 90d". */
export const CONVERSATION_RETENTION_DAYS = 90;

export type Ability =
  "canBuildCart" | "canRequestQuote" | "canReadOrders" | "canReadTerms";

/**
 * Read this shop's guardrails, creating the defaults on first use.
 *
 * Defaults matter more here than usual: they are what a merchant who never
 * opens the panel ships. Everything the agent can do without risk is on;
 * `guestMode` and `published` are off, because putting a wholesale concierge in
 * front of the public is a decision, not a default.
 */
export async function loadGuardrails(): Promise<AgentGuardrails> {
  const shop = shopScope.require("buyer agent guardrails");

  // Upserted rather than read-then-created: two buyers opening the widget in
  // the same second both find nothing and both insert, and the loser of that
  // race gets a unique-constraint error rather than an answer.
  return db.agentGuardrails.upsert({
    where: { shop },
    update: {},
    create: { ...tenant(), offLimits: [] },
  });
}

export interface GuardrailInput {
  published?: boolean;
  canBuildCart?: boolean;
  canRequestQuote?: boolean;
  canReadOrders?: boolean;
  canReadTerms?: boolean;
  guestMode?: boolean;
  tone?: string;
  customInstructions?: string | null;
  offLimits?: string[];
}

export function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
}

export class GuardrailValidationError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "GuardrailValidationError";
  }
}

export async function saveGuardrails(
  input: GuardrailInput,
  actorId: string | null,
): Promise<AgentGuardrails> {
  const shop = shopScope.require("save buyer agent guardrails");
  await loadGuardrails();

  if (input.tone !== undefined && !isTone(input.tone)) {
    throw new GuardrailValidationError("tone", `Unknown tone "${input.tone}".`);
  }

  const instructions = input.customInstructions?.trim() || null;
  if (instructions && countWords(instructions) > MAX_INSTRUCTION_WORDS) {
    throw new GuardrailValidationError(
      "customInstructions",
      `Instructions are ${countWords(instructions)} words; the limit is ${MAX_INSTRUCTION_WORDS}.`,
    );
  }

  return db.agentGuardrails.update({
    where: { shop },
    data: {
      ...(input.published === undefined
        ? {}
        : {
            published: input.published,
            publishedAt: input.published ? new Date() : null,
          }),
      ...(input.canBuildCart === undefined ? {} : { canBuildCart: input.canBuildCart }),
      ...(input.canRequestQuote === undefined
        ? {}
        : { canRequestQuote: input.canRequestQuote }),
      ...(input.canReadOrders === undefined
        ? {}
        : { canReadOrders: input.canReadOrders }),
      ...(input.canReadTerms === undefined ? {} : { canReadTerms: input.canReadTerms }),
      ...(input.guestMode === undefined ? {} : { guestMode: input.guestMode }),
      ...(input.tone === undefined ? {} : { tone: input.tone }),
      ...(input.customInstructions === undefined
        ? {}
        : { customInstructions: instructions }),
      ...(input.offLimits === undefined
        ? {}
        : {
            offLimits: input.offLimits
              .map((line) => line.trim())
              .filter((line) => line !== "")
              .slice(0, 20),
          }),
      updatedBy: actorId,
    },
  });
}

/* -------------------------------------------------------------------------- */
/* The lint                                                                    */
/* -------------------------------------------------------------------------- */

export interface InstructionWarning {
  /** A catalog key, so the warning is in the merchant's language. */
  key: string;
  /** The words that triggered it, quoted back. */
  phrase: string;
}

/**
 * Phrases that ask for something an ability has switched off.
 *
 * Deliberately a small, literal list rather than a model call. The checklist
 * asks for one specific service — "you wrote 'offer discounts freely' but
 * discount authority is off" — and a merchant deserves that warning
 * instantly, offline, for free, and identically every time they open the page.
 * It is a warning, never a block: the instructions cannot do the thing anyway,
 * so refusing to save them would be theatre.
 */
const CONTRADICTIONS: { ability: Ability; patterns: RegExp[]; key: string }[] = [
  {
    ability: "canBuildCart",
    key: "agent.lint.cart",
    patterns: [
      /\bbuild (?:them |the |a )?cart/iu,
      /\badd .{0,20}to (?:their |the )?cart/iu,
    ],
  },
  {
    ability: "canRequestQuote",
    key: "agent.lint.quote",
    patterns: [/\bquote\b/iu, /\bspecial price\b/iu],
  },
  {
    ability: "canReadOrders",
    key: "agent.lint.orders",
    patterns: [/\border status\b/iu, /\bwhere (?:is|'s) (?:their|my) order\b/iu],
  },
  {
    ability: "canReadTerms",
    key: "agent.lint.terms",
    patterns: [/\bnet terms\b/iu, /\bwhat they owe\b/iu, /\bcredit limit\b/iu],
  },
];

/** Phrases that ask for something no setting can grant. */
const NEVER: { patterns: RegExp[]; key: string }[] = [
  {
    key: "agent.lint.discountAuthority",
    patterns: [
      /\boffer\b.{0,20}\bdiscounts?\b/iu,
      /\bgive\b.{0,20}\b(?:a )?discount\b/iu,
      /\bnegotiate\b/iu,
      /\bmatch (?:any |their )?price\b/iu,
    ],
  },
  {
    key: "agent.lint.inventedPrice",
    patterns: [/\bmake up\b.{0,20}\bprice/iu, /\bestimate\b.{0,20}\bprice/iu],
  },
  {
    key: "agent.lint.checkout",
    patterns: [
      /\b(?:place|complete|submit) (?:the |their )?order\b/iu,
      /\bcheck ?out for\b/iu,
    ],
  },
];

/**
 * Read the merchant's instructions against what the agent may actually do.
 *
 * Returns warnings, not errors. Two kinds: something an ability has switched
 * off, and something the agent will never do whatever the settings say — the
 * second is the more useful of the two, because a merchant who has written
 * "offer discounts freely" believes their agent is doing it.
 */
export function lintInstructions(
  instructions: string | null,
  guardrails: Pick<AgentGuardrails, Ability>,
): InstructionWarning[] {
  if (!instructions || instructions.trim() === "") return [];

  const warnings: InstructionWarning[] = [];

  for (const rule of NEVER) {
    const hit = rule.patterns.map((pattern) => instructions.match(pattern)).find(Boolean);
    if (hit) warnings.push({ key: rule.key, phrase: hit[0].trim() });
  }

  for (const rule of CONTRADICTIONS) {
    if (guardrails[rule.ability]) continue;
    const hit = rule.patterns.map((pattern) => instructions.match(pattern)).find(Boolean);
    if (hit) warnings.push({ key: rule.key, phrase: hit[0].trim() });
  }

  return warnings;
}

/* -------------------------------------------------------------------------- */
/* Off-limits subjects                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Does this message touch something the merchant said to stay off?
 *
 * Checked here, in our code, before either model call. Listing the subjects in
 * the prompt and hoping was the first version: a merchant who writes "never
 * discuss our supplier" has said something about their business they expect to
 * hold, and "the model was asked nicely" is not how that expectation is met.
 *
 * Whole words, case-insensitively, in whatever script the subject is written
 * in — a merchant typing "competitors" must not silence "competitive".
 */
export function offLimitsHit(
  message: string,
  subjects: readonly string[],
): string | null {
  const haystack = message.toLowerCase();

  for (const subject of subjects) {
    const needle = subject.trim().toLowerCase();
    if (needle === "") continue;

    // A multi-word subject is a phrase; a single word is a word.
    if (needle.includes(" ")) {
      if (haystack.includes(needle)) return subject;
      continue;
    }

    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (
      new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(haystack)
    ) {
      return subject;
    }
  }

  return null;
}
