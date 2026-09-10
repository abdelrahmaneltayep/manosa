import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Enough Liquid to get a block into a browser.
 *
 * Not a Liquid implementation and not trying to be. Its whole purpose is to
 * produce the markup and — more importantly — the **script** that a real theme
 * would, so the JavaScript that actually ships can be driven in Chromium
 * against a stubbed proxy.
 *
 * What this proves: that the block's script parses, renders what the app sends,
 * and degrades the way it claims to. What it does not prove: that Shopify's own
 * Liquid renders it identically. `qa/3.4/REPORT.md` says so.
 *
 * It handles only the constructs the two order blocks use. Anything it does not
 * recognise is left in place, so a new construct shows up as visible rubbish in
 * a capture rather than as a silent difference.
 */

const LOCALE_FILES: Record<string, string> = {
  en: "en.default.json",
  ar: "ar.json",
};

/**
 * Which locale `| t` renders in.
 *
 * A module-level setting rather than a parameter threaded through every render
 * call, because the Liquid it stands in for has no concept of one either — a
 * theme is rendered in one language at a time.
 */
let locale = "en";

export function useLocale(next: string): void {
  locale = LOCALE_FILES[next] ? next : "en";
}

type Scope = Record<string, unknown>;

function lookup(path: string, scope: Scope): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) =>
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined,
      scope,
    );
}

function translations(): Record<string, unknown> {
  const file = resolve(
    process.cwd(),
    "extensions/mannon-storefront/locales",
    LOCALE_FILES[locale] ?? LOCALE_FILES.en!,
  );
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** `'mannon.a.b' | t`, including the pluralised and interpolated forms. */
function translate(key: string, args: Record<string, string>): string {
  const found = lookup(key, translations());

  let text: string;
  if (typeof found === "string") {
    text = found;
  } else if (found && typeof found === "object") {
    // `{ one, other }`, chosen by the count the caller passed.
    const forms = found as Record<string, string>;
    const count = Number(args.count ?? "0");
    // English has two categories and Arabic six; `other` is the one every
    // language has, so it is the fallback rather than a missing-key message.
    const category = count === 1 ? "one" : count === 2 ? "two" : "other";
    text = forms[category] ?? forms.other ?? key;
  } else {
    // Exactly what a real theme shows for a key that is not there, so a
    // missing one is visible in the capture rather than blank.
    return `translation missing: ${locale}.${key}`;
  }

  for (const [name, value] of Object.entries(args)) {
    text = text.replaceAll(`{{ ${name} }}`, value).replaceAll(`{{${name}}}`, value);
  }
  return text;
}

/**
 * `| t: count: variant.inventory_quantity` — the arguments a translation takes.
 *
 * Each value goes through `argValue`, so a variable path resolves rather than
 * being pasted in as its own name.
 */
function readFilterArgs(rest: string, scope: Scope): Record<string, string> {
  const args: Record<string, string> = {};
  for (const match of rest.matchAll(/(\w+):\s*([^,|]+)/g)) {
    args[match[1]!] = String(argValue(match[2]!, scope) ?? "");
  }
  return args;
}

function renderOutput(expression: string, scope: Scope): string {
  const [head, ...filters] = expression.split("|").map((part) => part.trim());
  let value: unknown;

  const literal = /^'([^']*)'$/.exec(head ?? "");
  if (literal) value = literal[1];
  else value = lookup(head ?? "", scope);

  for (const filter of filters) {
    const [name, ...rest] = filter.split(/[:\s]+/);
    const argsText = filter.slice((name ?? "").length + 1);

    if (name === "t") {
      value = translate(String(value), readFilterArgs(argsText, scope));
    } else if (name === "json") {
      value = JSON.stringify(value ?? "");
    } else if (name === "money") {
      // Minor units, as Liquid's own `money` takes them.
      const amount = Number(value ?? 0) / 100;
      value = `$${amount.toFixed(2)}`;
    } else if (name === "default") {
      if (value === undefined || value === null || value === "") {
        value = argValue(rest.join(" "), scope);
      }
    } else if (name === "append") {
      value = String(value ?? "") + String(argValue(rest.join(" "), scope) ?? "");
    } else if (name === "strip") {
      value = String(value ?? "").trim();
    }
  }

  return value === undefined || value === null ? "" : String(value);
}

/** A filter or comparison argument: a quoted literal, or a path to look up. */
function argValue(raw: string, scope: Scope): unknown {
  const text = raw.trim();
  if (!text) return "";
  const literal = /^['"](.*)['"]$/.exec(text);
  if (literal) return literal[1];
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text === "blank" || text === "empty") return "";
  const found = lookup(text, scope);
  return found === undefined ? text : found;
}

function truthy(expression: string, scope: Scope): boolean {
  const negated = expression.startsWith("unless ");
  const body = expression.replace(/^(if|unless|elsif)\s+/, "").trim();

  // `and` and `or`, left to right — Liquid has no precedence between them
  // either, so this matches rather than approximating.
  if (/\s+and\s+/.test(body)) {
    const parts = body.split(/\s+and\s+/);
    const result = parts.every((part) => truthy(part, scope));
    return negated ? !result : result;
  }
  if (/\s+or\s+/.test(body)) {
    const parts = body.split(/\s+or\s+/);
    const result = parts.some((part) => truthy(part, scope));
    return negated ? !result : result;
  }

  let result: boolean;
  const comparison = /^(\S+)\s*(==|!=|>|<=)\s*(.+)$/.exec(body);
  if (comparison) {
    const [, left, operator, rightRaw] = comparison;
    const a = lookup(left!, scope) ?? "";
    const b = argValue(rightRaw!, scope);
    result =
      operator === "=="
        ? a === b
        : operator === "!="
          ? a !== b
          : operator === ">"
            ? Number(a) > Number(b)
            : Number(a) <= Number(b);
  } else if (body.endsWith(" != blank")) {
    result = Boolean(lookup(body.replace(" != blank", ""), scope));
  } else {
    const value = lookup(body, scope);
    result = Boolean(value) && value !== "";
  }

  return negated ? !result : result;
}

/** Strip the parts a browser has no use for. */
function stripBlocks(source: string): string {
  return source
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "")
    .replace(/\{%\s*schema\s*%\}[\s\S]*?\{%\s*endschema\s*%\}/g, "");
}

/**
 * Render one block.
 *
 * `scope` supplies `block`, `product`, `routes` and `request` — whatever the
 * block reads. Anything missing renders empty, as Liquid does.
 */
export function renderBlock(name: string, scope: Scope): string {
  const source = stripBlocks(
    readFileSync(
      resolve(process.cwd(), "extensions/mannon-storefront/blocks", name),
      "utf8",
    ),
  );

  return render(source, scope);
}

function render(source: string, scope: Scope): string {
  let out = "";
  let index = 0;

  const tag = /\{%-?\s*([\s\S]*?)\s*-?%\}/g;
  let match: RegExpExecArray | null;

  while ((match = tag.exec(source)) !== null) {
    out += renderText(source.slice(index, match.index), scope);
    const body = match[1]!.trim();

    if (body.startsWith("assign ")) {
      const [, name, expression] = /^assign\s+(\w+)\s*=\s*([\s\S]+)$/.exec(body) ?? [];
      if (name) scope[name] = renderOutput(expression ?? "", scope);
      index = tag.lastIndex;
      continue;
    }

    if (body.startsWith("if ") || body.startsWith("unless ")) {
      const { block, rest, lastIndex } = takeBlock(source, tag.lastIndex);
      out += truthy(body, scope) ? render(block, scope) : render(rest, scope);
      index = lastIndex;
      tag.lastIndex = lastIndex;
      continue;
    }

    if (body.startsWith("for ")) {
      const [, item, listPath] = /^for\s+(\w+)\s+in\s+([\w.]+)/.exec(body) ?? [];
      const { block, lastIndex } = takeBlock(source, tag.lastIndex);
      const list = (lookup(listPath ?? "", scope) as unknown[]) ?? [];

      list.forEach((entry, position) => {
        out += render(block, {
          ...scope,
          [item!]: entry,
          forloop: { index: position + 1, index0: position, first: position === 0 },
        });
      });

      index = lastIndex;
      tag.lastIndex = lastIndex;
      continue;
    }

    // Anything unrecognised is dropped rather than guessed at.
    index = tag.lastIndex;
  }

  return out + renderText(source.slice(index), scope);
}

/**
 * Find the body of a block tag and, for `if`, whatever follows `else`.
 *
 * Counts nesting so an inner `if` does not close an outer one. The end tag is
 * matched generically, which is what Liquid's own parser would refuse — but a
 * mismatched pair is a template bug, and this exists to render, not to validate.
 */
function takeBlock(
  source: string,
  from: number,
): { block: string; rest: string; lastIndex: number } {
  const tag = /\{%-?\s*([\s\S]*?)\s*-?%\}/g;
  tag.lastIndex = from;

  let depth = 1;
  // Where the `{% else %}` tag starts and ends, so both halves slice cleanly.
  let elseStart = -1;
  let elseEnd = -1;
  let match: RegExpExecArray | null;

  while ((match = tag.exec(source)) !== null) {
    const body = match[1]!.trim();

    if (/^(if|unless|for)\s/.test(body)) {
      depth += 1;
      continue;
    }

    if (/^end(if|unless|for)$/.test(body)) {
      depth -= 1;
      if (depth > 0) continue;

      return elseStart === -1
        ? { block: source.slice(from, match.index), rest: "", lastIndex: tag.lastIndex }
        : {
            block: source.slice(from, elseStart),
            rest: source.slice(elseEnd, match.index),
            lastIndex: tag.lastIndex,
          };
    }

    if (body === "else" && depth === 1) {
      elseStart = match.index;
      elseEnd = tag.lastIndex;
    }
  }

  // Unclosed. Rendering what is there beats throwing on a template a browser
  // would have shown something for.
  return { block: source.slice(from), rest: "", lastIndex: source.length };
}

function renderText(text: string, scope: Scope): string {
  return text.replace(/\{\{-?\s*([\s\S]*?)\s*-?\}\}/g, (_whole, expression: string) =>
    renderOutput(expression, scope),
  );
}
