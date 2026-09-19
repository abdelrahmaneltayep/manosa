import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  declaredHandle,
  pinClientId,
  pinnedClientId,
  pushesConfig,
  whyNotAClientId,
  whyNotDeployable,
} from "~/lib/release/app-identity";

/**
 * Which Shopify app this repository deploys to, and where its storefront
 * blocks call it.
 *
 * Both were "mannon", and an app with that handle already exists: it is
 * deployed from the `manosh` repository and has a released version built from
 * a different extension set. With no `client_id` pinned, `shopify app deploy`
 * from here would have bound to that app by handle and — because
 * `include_config_on_deploy = true` — written this file over its config and
 * released this repo's extensions in place of its own. Nothing would have
 * warned; the CLI prints the app it picked in an info box and carries on.
 */

const root = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const TOML = root("shopify.app.toml");

/** The file as it was before `shopify app config link` named an app. */
const UNPINNED = TOML.replace(/^client_id[ \t]*=.*$/m, '# client_id = ""');

describe("this repository's app identity", () => {
  it("does not claim the handle the other app already has", () => {
    expect(declaredHandle(TOML)).not.toBe("mannon");
    expect(declaredHandle(TOML)).toBe("mannon-wholesale");
  });

  it("still pushes its config on deploy, which is why the guard exists", () => {
    // Not a defect — it is why this app config is reviewable in the diff at
    // all. It is also exactly what makes deploying to the wrong app
    // destructive rather than merely wrong.
    expect(pushesConfig(TOML)).toBe(true);
  });

  it("names exactly one app, and deploying is allowed to it", () => {
    // The state since `shopify app config link` ran. If this fails, something
    // re-pointed the repository — which is the whole thing the guard is for.
    const pinned = pinnedClientId(TOML);

    expect(pinned).toMatch(/^[a-f0-9]{32}$/);
    expect(whyNotDeployable(TOML, undefined)).toBeNull();
    expect(whyNotDeployable(TOML, pinned!)).toBeNull();
    expect(whyNotDeployable(TOML, `  ${pinned}  `)).toBeNull();
  });

  it("refuses to deploy when nothing is pinned", () => {
    const problem = whyNotDeployable(UNPINNED, undefined);

    expect(problem).not.toBeNull();
    expect(problem!.reason).toContain("pins no client_id");
    expect(problem!.reason).toContain("mannon-wholesale");
    expect(problem!.remedy).toContain("shopify app config link");
  });

  it("refuses when the environment names a different app than the file", () => {
    // The case an absent-minded `shopify app config link --reset` creates: the
    // file is re-pinned to whatever was picked in the prompt, and the deployer
    // never reads it. A release cannot be taken back from merchants who have it.
    const problem = whyNotDeployable(TOML, "401839423489");

    expect(problem!.reason).toContain(pinnedClientId(TOML)!);
    expect(problem!.reason).toContain("401839423489");
  });

  it("treats an empty client_id as no client_id", () => {
    expect(pinnedClientId('client_id = ""')).toBeNull();
    expect(pinnedClientId('client_id = "   "')).toBeNull();
    expect(pinnedClientId('# client_id = "abc"')).toBeNull();
  });
});

describe("the App Proxy subpath", () => {
  const subpath = TOML.match(/^[ \t]*subpath[ \t]*=[ \t]*"([^"]*)"/m)?.[1];

  it("is distinct, because one store can install both apps", () => {
    // Shopify gives one prefix+subpath to one app. Two apps declaring
    // `/apps/mannon` on the same store is a conflict the merchant sees.
    expect(subpath).toBe("mannon-wholesale");
  });

  it("is the path every storefront block actually calls", () => {
    // The blocks are Liquid and cannot import this value, so the two are two
    // writers of one fact — and the fact only shows up wrong on a real
    // storefront, where this repo cannot look.
    const blocks = "extensions/mannon-storefront/blocks";
    const wrong: string[] = [];

    for (const file of readdirSync(resolve(process.cwd(), blocks))) {
      if (!file.endsWith(".liquid")) continue;
      for (const call of root(`${blocks}/${file}`).matchAll(/apps\/([\w-]+)\//g)) {
        if (call[1] !== subpath) wrong.push(`${file}: apps/${call[1]}/`);
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe("pinning this repository to one app", () => {
  const KEY = "1a2b3c4d5e6f70819a2b3c4d5e6f7081";

  it("accepts an API key", () => {
    expect(whyNotAClientId(KEY)).toBeNull();
    expect(whyNotAClientId(`  ${KEY}  `)).toBeNull();
  });

  it("refuses the numeric id out of a dashboard URL", () => {
    // `/apps/401839423489/versions/…` is the id a person has on screen when
    // they come to do this, and it is not the app's API key.
    expect(whyNotAClientId("401839423489")).toContain("different id");
  });

  it("refuses the things that look plausible in a diff", () => {
    for (const value of [
      "",
      "   ",
      "mannon-wholesale",
      `"${KEY}"`,
      `${KEY} `.repeat(2),
    ]) {
      expect(whyNotAClientId(value), JSON.stringify(value)).not.toBeNull();
    }
  });

  it("replaces the commented placeholder rather than living beside it", () => {
    const pinned = pinClientId(UNPINNED, KEY);

    expect(pinnedClientId(pinned)).toBe(KEY);
    // Two client_id lines, one commented, is a file that reads as pinned to
    // whichever one the reader's eye lands on.
    expect(pinned.match(/client_id[ \t]*=/g) ?? []).toHaveLength(1);
  });

  it("puts the line in the root table, where the CLI reads it", () => {
    const pinned = pinClientId(UNPINNED, KEY);
    const line = pinned.indexOf(`client_id = "${KEY}"`);
    const firstTable = pinned.search(/^\[/m);

    // Below `handle`, above the first `[table]`. A client_id inside `[build]`
    // is a key nothing reads and a file that looks pinned.
    expect(line).toBeGreaterThan(pinned.indexOf("handle ="));
    expect(line).toBeLessThan(firstTable);
  });

  it("makes the deploy guard pass, and nothing else in the file move", () => {
    const pinned = pinClientId(UNPINNED, KEY);

    expect(whyNotDeployable(pinned, undefined)).toBeNull();
    expect(declaredHandle(pinned)).toBe("mannon-wholesale");
    // One line different from the file it was given, and that line is this one.
    expect(pinned.replace(/^client_id = .*$/m, '# client_id = ""')).toBe(UNPINNED);
  });

  it("re-pins a repository that already names an app", () => {
    // The live file is pinned, so this is the path a re-link takes. It is
    // allowed here and refused by the script without --force, which is where
    // the decision belongs.
    const moved = pinClientId(TOML, KEY);

    expect(pinnedClientId(moved)).toBe(KEY);
    expect(moved.match(/client_id[ \t]*=/g) ?? []).toHaveLength(1);
  });

  it("refuses to write a client_id it would not accept", () => {
    expect(() => pinClientId(TOML, "401839423489")).toThrow("different id");
  });
});
