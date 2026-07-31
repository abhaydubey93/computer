// Resolve the published @cloudflare/computer/shell/* subpaths and
// @cloudflare/computer/empty to their source files for the test
// runners. shell-modules.ts imports the shell-module groups by
// subpath so a consumer's wrangler `alias` can drop a feature;
// those subpaths resolve through the package's dist exports,
// which a src-based test run doesn't build. Point them at the
// generated src files (and the empty stub) instead.

import { resolve } from "node:path";

const src = resolve(import.meta.dirname, "..", "src", "backends", "worker");

const groups = ["core", "curl", "html-to-markdown", "python", "sqlite", "js-exec"] as const;

export const shellModuleAliases = [
  ...groups.map((group) => ({
    find: `@cloudflare/computer/shell/${group}`,
    replacement: resolve(src, "generated", `${group}.ts`),
  })),
  {
    find: "@cloudflare/computer/empty",
    replacement: resolve(src, "empty.ts"),
  },
];
