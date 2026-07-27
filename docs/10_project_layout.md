# 10. Project Layout

> NOTE: This doc reflects the real monorepo layout. Packages marked
> **(planned)** are not yet implemented.

The workspace ships as a monorepo. Each published package lives under
`packages/`; runnable examples sit under `examples/`. The repo-root
`package.json` declares the workspaces glob:

```json
{
  "workspaces": ["packages/*", "examples/*"]
}
```

```
workspace/
├── packages/
│   ├── workspace/         # @cloudflare/workspace — DO-side facade, backends, proxy
│   ├── vfs/               # @cloudflare/dofs — SQLite-backed VFS + sync
│   ├── rpc/               # @cloudflare/workspace-rpc — capnweb wire interface
│   ├── wsd/               # @cloudflare/workspace-wsd — in-container daemon (binary)
│   ├── fs-tools/          # (planned) AI SDK file tools + FileStore
│   └── git-tools/         # (planned) AI SDK git tools
├── examples/
│   └── container/     # Reference container image for the wsd daemon
├── docs/                  # This documentation set
└── package.json           # Workspace root (workspaces: packages/*, examples/*)
```

### Folder rename history

Two renames have landed:

- `packages/workspace-rpc/` → `packages/rpc/` (folder only). The npm
  package is still `@cloudflare/workspace-rpc`.
- `packages/workspace-fs/` → `packages/dofs/`, and the npm package
  was renamed `@cloudflare/workspace-fs` → `@cloudflare/dofs`.

If you grep older history or other docs and find the old folder paths,
they refer to the same code under the new names.

## `packages/workspace/` — `@cloudflare/workspace`

The DO-side facade. Owns the `Workspace` class, re-exports
`WorkspaceFilesystem` from `@cloudflare/dofs`, exposes the
`WorkspaceShell` surface, and selects between pluggable backends
(real Cloudflare container vs. test backend). Also ships the
`WorkspaceProxy` used by clients that want to talk to a workspace
through an RPC stub.

```
packages/workspace/
├── src/
│   ├── index.ts                     # Public entrypoint
│   ├── workspace.ts                 # Workspace facade
│   ├── shell.ts                     # WorkspaceShell
│   ├── backend.ts                   # Backend interface
 │   ├── backends/
 │   │   ├── container/               # Cloudflare Container + wsd backend
 │   │   ├── worker/                  # Dynamic Worker + just-bash backend
 │   │   ├── codemode/                # Dynamic Worker + JavaScript sandbox backend
 │   │   └── test.ts                  # In-process test backend
│   ├── proxy.ts                     # WorkspaceProxy
│   ├── proxy-stub.ts                # Client-side stub plumbing
│   ├── stub.ts                      # DO stub helpers
│   ├── test-harness-worker.ts       # Worker entrypoint for the harness
│   └── test-harness/                # Integration test wiring
├── tsconfig.json
├── tsconfig.build.json              # ESM build (extends ./tsconfig.json)
├── tsconfig.cjs.json                # CJS build
└── package.json
```

Build: dual ESM + CJS via two `tsc` invocations
(`tsc -p tsconfig.build.json && tsc -p tsconfig.cjs.json`). The
`package.json` declares a single `.` export resolving to
`dist/cjs/index.js` (CJS) with ESM types alongside. There is no
`ws.js` or `shared.js` — the injected service is the separate `wsd`
package, and shared wire types live in `@cloudflare/workspace-rpc`.

## `packages/dofs/` — `@cloudflare/dofs`

SQLite-backed virtual filesystem. Holds the schema, sync primitives,
and the filesystem verbs that everything else builds on. See doc 04
for the surface, and docs 02–03 for sync semantics.

```
packages/dofs/
├── src/
│   ├── index.ts                     # Public entrypoint (`.` export)
│   ├── provider.ts                  # VFS provider
│   ├── path.ts                      # Canonicalization, parsing
│   ├── rev.ts                       # Revision / version helpers
│   ├── errors.ts                    # Typed errors
│   ├── storage.ts                   # SQLite storage layer
│   ├── types.ts                     # Shared VFS types
│   ├── testing.ts                   # `./testing` export
│   ├── testing-recording.ts         # Recording test harness
│   ├── gc.ts                        # Garbage collection helper
│   ├── fs/                          # fs verbs: readFile, writeFile, ls,
│   │                                #   find, grep, stat, rm, mkdir,
│   │                                #   readdir, symlink, readlink,
│   │                                #   watch, resolve, filesystem
│   ├── schema/                      # core schema + sync schema
│   └── sync/                        # manifests, changes, push, fetch,
│                                    #   apply, watermarks, blobs,
│                                    #   coalesce, ignore, invariant
├── tsconfig.json
├── tsconfig.build.json
└── package.json                     # exports: `.`, `./testing`
```

Exports resolve to `dist/index.js` and `dist/testing.js`.

## `packages/rpc/` — `@cloudflare/workspace-rpc`

The capnweb wire interface that joins DO-side and container-side
processes. `WorkspaceRPC` is the union of the sync and shell
interfaces. Client and server stubs are published as separate
subpath exports, and the sync driver wires the VFS to the wire.

```
packages/rpc/
├── src/
│   ├── interface.ts                 # WorkspaceRPC = sync + shell
│   ├── client.ts                    # Client stub (`./client`)
│   ├── server.ts                    # Server stub (`./server`)
│   ├── sync-driver.ts               # Sync driver (`./driver`)
│   ├── wire.test.ts                 # Wire round-trip tests
│   └── index.ts                     # `.` export
├── tsconfig.json
├── tsconfig.build.json
└── package.json                     # exports: `.`, `./server`, `./client`, `./driver`
```

## `packages/wsd/` — `@cloudflare/workspace-wsd`

The in-container daemon. Built as a single-file native binary named
`wsd` that runs inside the sandbox container. It owns the FUSE
mount, the exec runner, and dials back to the DO over WebSocket via
the `rpc` package. (Replaces the historical `ws.js` injected script;
see doc 07.)


```
packages/wsd/
├── src/
│   ├── cli/
│   │   └── wsd.ts                   # CLI entry
│   ├── fuse/
│   │   ├── driver.ts
│   │   ├── backend.ts
│   │   ├── vfs.ts
│   │   ├── fuse-native.d.ts         # fuse-native typings
│   │   └── index.ts
│   └── exec/
│       ├── runner.ts
│       ├── schema.ts
│       ├── types.ts
│       ├── log.ts
│       └── index.ts
├── scripts/
│   ├── build.mjs                    # → dist/cli/wsd.cjs
│   ├── build-bin.mjs                # SEA driver
│   └── sea/
│       └── bundle.mjs               # esbuild → SEA bundle
├── artifacts/
│   └── wsd/
│       ├── wsd-linux-x64
│       └── wsd-macos-x64
├── tsconfig.json
└── package.json
```

Build pipeline: `scripts/build.mjs` emits `dist/cli/wsd.cjs`;
`scripts/build-bin.mjs` together with `scripts/sea/bundle.mjs`
produces the Node SEA single-file binary at
`artifacts/wsd/wsd-{linux,macos}-x64`.

## `packages/fs-tools/` — **(planned)**

AI SDK tools (`read`, `write`, `edit`, `grep`, `exec`) plus the
`FileStore` abstraction the file-shaped ones drive. See
[09. Tool Interface (Agents)](./09_tool_interface.md). Not
implemented yet.

## Git

Git access ships through `workspace.git` on the main
`@cloudflare/workspace` package rather than a separate package.
Both a typed JavaScript API and an argv-driven entry point are
available; the worker backend's shell isolate also exposes a
built-in `git` command that forwards to the same dispatcher.
See
[13. Git interface](./13_git_interface.md).

## Examples

Runnable examples live at the repo root, not inside any package:

```
examples/
└── container/        # Reference container image for wsd
```

The root `package.json` includes `examples/*` in its workspaces glob
so each example can declare its own dependencies and scripts.

## Testing

- **Unit tests live next to source.** Every package follows the
  `foo.ts` + `foo.test.ts` convention. There is no top-level
  `tests/` directory anywhere in the repo.
- **Integration / harness tests** for the workspace package live in
  `packages/workspace/test-harness/`:
  - `end-to-end.test.ts` — DO ↔ container round-trip
  - `shell.test.ts` — shell surface against a real backend
  - `load.bench.ts` — load / soak benchmark
  - `run-harness.sh` — driver script
  - `vitest.config.harness.ts` — bespoke vitest config for the harness

## Tooling

- **TypeScript.** Each package has its own `tsconfig.json` — there
  is no shared root config. Per-package `tsconfig.build.json` files
  extend `./tsconfig.json` to configure the build output.
- **Biome.** Both linter and formatter are enabled in `biome.jsonc`
  at the repo root (`biome check` covers lint + format; `biome
  format` formats only). No ESLint, no Prettier.
- **esbuild.** Used by `packages/wsd/scripts/sea/bundle.mjs` to
  produce the single-file `wsd` SEA bundle. Application bundling is
  left to consumers.
- **vitest.** Drives unit tests in every package. `wsd` additionally
  uses `node --experimental-strip-types --test` for some scripts
  given its native-binary nature.
