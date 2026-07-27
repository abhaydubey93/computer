// Workerd-backed runner for the CodemodeBackend integration tests.
// The default vitest config aliases cloudflare:workers to a throwing
// stub so the node runner doesn't have to resolve it; the codemode
// backend's real wiring (Worker Loader binding, the codemode
// DynamicWorkerExecutor minting a sandbox isolate, the state.*
// dispatchers, the fs round-trip) only works under workerd. Drives
// that path through SELF.fetch.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.codemode-backend.jsonc" },
    }),
  ],
  test: {
    globals: true,
    include: ["tests/codemode-backend.test.ts"],
    // Each exec mints a fresh sandbox isolate through the Worker
    // Loader; cold-start of that isolate dominates the runtime, so
    // give each case generous headroom.
    testTimeout: 60_000,
  },
});
