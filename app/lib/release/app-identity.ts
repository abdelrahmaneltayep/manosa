/**
 * Which Shopify app this repository deploys to.
 *
 * `shopify app config link` binds a repo to an app by **handle** when no
 * `client_id` is pinned. This file says `handle = "mannon"`, and an app with
 * that handle already exists and already has a released version — built from a
 * different repository, with a different set of extensions.
 *
 * So an unpinned `client_id` here is not an empty field waiting to be filled.
 * It is a deploy from this repo silently adopting that app and, because
 * `include_config_on_deploy = true`, overwriting its `application_url`, its
 * redirect URLs, its App Proxy and its access scopes — then releasing a
 * version containing only this repo's extensions, which removes the other
 * repo's from the live app.
 *
 * Nothing warns about that. The CLI prints the org and app it picked in an
 * info box and carries on, which is exactly how two codebases end up fighting
 * over one app listing.
 */

/** The `client_id = "..."` a deploy is allowed to proceed on. */
export function pinnedClientId(toml: string): string | null {
  const match = toml.match(/^[ \t]*client_id[ \t]*=[ \t]*"([^"]*)"/m);
  const value = match?.[1]?.trim();
  return value ? value : null;
}

/** The app handle this file claims, which is what an unpinned link matches on. */
export function declaredHandle(toml: string): string | null {
  return toml.match(/^[ \t]*handle[ \t]*=[ \t]*"([^"]*)"/m)?.[1]?.trim() || null;
}

/** Whether the config this deploy carries would be pushed over the app's own. */
export function pushesConfig(toml: string): boolean {
  return /^[ \t]*include_config_on_deploy[ \t]*=[ \t]*true/m.test(toml);
}

export interface IdentityProblem {
  reason: string;
  /** What to do, in the words that do it. */
  remedy: string;
}

/**
 * Why this repository must not run `shopify app deploy` yet, or null.
 *
 * `expected` is `SHOPIFY_APP_CLIENT_ID` when the deployer has set it — the
 * belt to the pinned file's braces, so a repo that is re-linked to the wrong
 * app by an absent-minded `--reset` still fails before it releases.
 */
export function whyNotDeployable(
  toml: string,
  expected: string | undefined,
): IdentityProblem | null {
  const pinned = pinnedClientId(toml);
  const handle = declaredHandle(toml);

  if (!pinned) {
    return {
      reason:
        `shopify.app.toml pins no client_id, so the CLI would bind this repo to ` +
        `whichever app matches handle "${handle ?? "?"}"` +
        (pushesConfig(toml)
          ? ` — and include_config_on_deploy = true means this repo's config would ` +
            `then be written over that app's, and its extension set over that app's.`
          : "."),
      remedy:
        "Run `shopify app config link`, check the org and app it names, and commit " +
        "the client_id it writes. Deploying is refused until that line is in the file.",
    };
  }

  if (expected && expected.trim() && expected.trim() !== pinned) {
    return {
      reason: `shopify.app.toml is pinned to ${pinned}, but SHOPIFY_APP_CLIENT_ID says ${expected.trim()}.`,
      remedy:
        "One of the two is from another app. Settle which app this repo owns before deploying; " +
        "a release cannot be taken back from the merchants who already have it.",
    };
  }

  return null;
}

/**
 * Why this is not a client_id, or null.
 *
 * Shopify's is the app's API key: hex, no punctuation. Worth checking because
 * the three things people paste instead all look plausible in a diff — the
 * numeric app id out of a dashboard URL, the app's name, and a value that came
 * with a stray quote attached. None of them is an app, and `check:app` would
 * accept any of them as "pinned".
 */
export function whyNotAClientId(value: string): string | null {
  const text = value.trim();
  if (!text) return "No client_id was given.";
  if (!/^[a-f0-9]{16,64}$/i.test(text)) {
    return (
      `"${text}" does not look like a client_id. It is the app's API key — hex, ` +
      `32 characters in every app I have seen. The number in a dashboard URL ` +
      `(/apps/401839423489/) is a different id.`
    );
  }
  return null;
}

/**
 * The same file, pinned to one app.
 *
 * Replaces the commented placeholder if it is there, and otherwise writes the
 * line under `handle` — never appends blindly, because a `client_id` outside
 * the root table is a key the CLI does not read and a file that looks pinned.
 */
export function pinClientId(toml: string, clientId: string): string {
  const reason = whyNotAClientId(clientId);
  if (reason) throw new Error(reason);

  const line = `client_id = "${clientId.trim()}"`;
  return /^[ \t]*#?[ \t]*client_id[ \t]*=.*$/m.test(toml)
    ? toml.replace(/^[ \t]*#?[ \t]*client_id[ \t]*=.*$/m, line)
    : toml.replace(/^(handle[ \t]*=.*)$/m, `$1\n${line}`);
}
