// Tests the shape shell-modules.ts assembles from the per-feature
// groups build-bundle.mjs emits under generated/.
//
// The bundle used to be a single ~3 MB JS string. esbuild was
// inlining every dynamic import() just-bash makes (python3,
// js-exec, sqlite3, html-to-markdown, curl, …) into the one
// string, so workerd's Worker Loader parsed all of it on every
// cold start even though the default ShellWorker disables python,
// javascript, and network.
//
// build-bundle.mjs now runs esbuild with splitting: true and
// partitions the emitted modules into a core group plus one group
// per optional command. shell-modules.ts imports each group by
// its @cloudflare/computer/shell/* subpath and spreads them into
// SHELL_MODULES; the host Worker hands that to the Loader callback,
// and workerd parses each chunk on first import. A consumer can
// alias a group's subpath to @cloudflare/computer/empty to drop
// the feature's chunks from the upload. These tests are the
// contract.

import curlModules from "@cloudflare/computer/shell/curl";
import htmlToMarkdownModules from "@cloudflare/computer/shell/html-to-markdown";
import { describe, expect, it } from "vitest";
import { SHELL_MODULES } from "./shell-modules.js";

describe("SHELL_MODULES", () => {
  it("exposes shell.js as the main module", () => {
    expect(SHELL_MODULES["shell.js"]).toBeDefined();
    expect(typeof SHELL_MODULES["shell.js"].js).toBe("string");
    expect(SHELL_MODULES["shell.js"].js.length).toBeGreaterThan(0);
  });

  it("keeps the main module under 1 MB so cold start parses ~650 KB, not 3 MB", () => {
    // Static-reachable set from entrypoint.ts measured at ~651 KB.
    // Anything materially above that means esbuild stopped
    // splitting and went back to inlining dynamic imports.
    const mainBytes = SHELL_MODULES["shell.js"].js.length;
    expect(mainBytes).toBeLessThan(1_000_000);
  });

  it("splits dynamic just-bash chunks into separate modules", () => {
    // The whole point of splitting: the bundle is no longer one
    // blob. At least one chunk besides shell.js should be present.
    const names = Object.keys(SHELL_MODULES);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain("shell.js");
  });

  it("emits chunk module names with a .js extension", () => {
    // workerd's Worker Loader rejects extensionless module names
    // for bare-string modules; chunks must keep their .js suffix.
    for (const name of Object.keys(SHELL_MODULES)) {
      expect(name.endsWith(".js")).toBe(true);
    }
  });

  it("every module entry has a js source string", () => {
    for (const [name, mod] of Object.entries(SHELL_MODULES)) {
      expect(typeof mod.js, `module ${name}`).toBe("string");
      expect(mod.js.length, `module ${name} non-empty`).toBeGreaterThan(0);
    }
  });

  it("carries each optional feature's chunks in its own group", () => {
    // curl and html-to-markdown own the two heaviest dependency
    // chunks (undici, domino). They must be assembled into
    // SHELL_MODULES by default, and live in their own group so a
    // consumer can alias the group out.
    expect(Object.keys(curlModules).length).toBeGreaterThan(0);
    expect(Object.keys(htmlToMarkdownModules).length).toBeGreaterThan(0);
    for (const name of Object.keys(curlModules)) {
      expect(SHELL_MODULES[name]).toBeDefined();
    }
    for (const name of Object.keys(htmlToMarkdownModules)) {
      expect(SHELL_MODULES[name]).toBeDefined();
    }
  });

  it("keeps feature groups disjoint from each other", () => {
    // A chunk owned by curl must not also appear in the
    // html-to-markdown group; a shared chunk belongs in core.
    const curlNames = new Set(Object.keys(curlModules));
    for (const name of Object.keys(htmlToMarkdownModules)) {
      expect(curlNames.has(name), `${name} in both groups`).toBe(false);
    }
  });
});
