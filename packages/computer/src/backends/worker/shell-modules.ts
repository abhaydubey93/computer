// Assembles SHELL_MODULES from the per-feature module groups
// build-bundle.mjs emits under generated/.
//
// Each group is imported through its @cloudflare/computer/shell/*
// subpath rather than a relative path so a consumer can drop a
// feature at build time without patching this package. Aliasing
// the subpath to @cloudflare/computer/empty in wrangler.jsonc:
//
//   "alias": {
//     "@cloudflare/computer/shell/curl": "@cloudflare/computer/empty",
//     "@cloudflare/computer/shell/html-to-markdown": "@cloudflare/computer/empty"
//   }
//
// swaps that group for an empty record, and the feature's
// exclusive chunks — curl's undici (~620 KB), html-to-markdown's
// domino (~555 KB), and the like — never enter the uploaded
// Worker. The command still parses; invoking it fails at runtime
// with a "module not found" once its chunk is gone. Leaving the
// alias out ships every group, byte-for-byte the single-file
// bundle.

import coreModules from "@cloudflare/computer/shell/core";
import curlModules from "@cloudflare/computer/shell/curl";
import htmlToMarkdownModules from "@cloudflare/computer/shell/html-to-markdown";
import jsExecModules from "@cloudflare/computer/shell/js-exec";
import pythonModules from "@cloudflare/computer/shell/python";
import sqliteModules from "@cloudflare/computer/shell/sqlite";

export const SHELL_MODULES: Readonly<Record<string, { js: string }>> = Object.freeze({
  ...coreModules,
  ...curlModules,
  ...htmlToMarkdownModules,
  ...pythonModules,
  ...sqliteModules,
  ...jsExecModules,
});
