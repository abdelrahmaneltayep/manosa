import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The Anthropic key must never reach a browser.
 *
 * Two guards, because one is a convention and the other is a fact. The naming
 * convention (`.server.ts`) is what makes Remix exclude a module from the
 * client build; this asserts the convention is actually followed, and — when a
 * build exists — that the built client carries neither the SDK nor the key.
 */

const AI = resolve(process.cwd(), "app/lib/ai");
const CLIENT_BUILD = resolve(process.cwd(), "build/client");

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

describe("the AI modules", () => {
  const modules = readdirSync(AI).filter((name) => name.endsWith(".ts"));

  it("names every module that touches the SDK or the database `.server`", () => {
    const leaked: string[] = [];

    for (const name of modules) {
      const source = readFileSync(join(AI, name), "utf8");
      const touchesServer =
        source.includes("@anthropic-ai/sdk") ||
        source.includes("~/db.server") ||
        source.includes("process.env.ANTHROPIC");
      if (touchesServer && !name.endsWith(".server.ts")) leaked.push(name);
    }

    // `model.ts` is the deliberate exception: pure constants, no client, no
    // key, importable from anywhere including a test.
    expect(leaked).toEqual([]);
  });

  it("keeps the key out of every module that is not `.server`", () => {
    for (const name of modules.filter((file) => !file.endsWith(".server.ts"))) {
      expect(readFileSync(join(AI, name), "utf8"), name).not.toContain(
        "ANTHROPIC_API_KEY",
      );
    }
  });
});

describe("the built client bundle", () => {
  const built = statSync(CLIENT_BUILD, { throwIfNoEntry: false });

  it.runIf(built)("carries no key, no SDK and no Anthropic endpoint", () => {
    const offenders: string[] = [];

    for (const file of filesIn(CLIENT_BUILD)) {
      if (!/\.(js|mjs|css|map)$/.test(file)) continue;
      const source = readFileSync(file, "utf8");
      for (const needle of [
        "ANTHROPIC_API_KEY",
        "@anthropic-ai/sdk",
        "api.anthropic.com",
        "sk-ant-",
      ]) {
        if (source.includes(needle)) {
          offenders.push(`${file.replace(CLIENT_BUILD, "build/client")}: ${needle}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("says so when there is no build to check", () => {
    // Not a silent pass: `npm run build` before `npm test` is what makes the
    // check above mean anything, and CI does both.
    if (!built) {
      console.info("[mannon] no build/client — run `npm run build` to check the bundle");
    }
    expect(true).toBe(true);
  });
});
