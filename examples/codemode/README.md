# codemode example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.

A Cloudflare Worker + Durable Object that runs one Workspace with
**three backends** and an optional **agent** layer on top:

- **`shell`** — [`just-bash`](https://github.com/vercel-labs/just-bash)
  in a Dynamic Worker. Fast, no container, broad text tooling.
- **`codemode`** — LLM-authored **JavaScript** in a Dynamic Worker,
  reaching the files through a `state.*` namespace. This is the
  backend the example is built to show off.
- **`container`** — `wsd` in a Cloudflare Container, a full Linux
  userland. Boots on first use only.

The workspace itself knows nothing about models. Agency is a
separate, opt-in layer: a `POST /agent` route runs a
[Workers AI](https://developers.cloudflare.com/workers-ai/) model
loop that drives the backends through an `exec` tool, and picks the
backend per command.

## What makes codemode different

The `shell` and `container` backends take a **shell command line**.
The `codemode` backend takes a **JavaScript snippet**. It runs the
snippet in an isolated Dynamic Worker and reports the return value
plus `console.log` output as stdout; a thrown error becomes stderr
with a non-zero exit code. The snippet reaches the filesystem
through a `state.*` namespace:

```js
await state.mkdir("/workspace", { recursive: true });
await state.writeFile("/workspace/hello.txt", "hello world");
return await state.readFile("/workspace/hello.txt");
```

The `state.*` namespace mirrors the filesystem surface the `shell`
backend already reaches — there is no security reason to keep it
smaller, since the agent chooses the backend and all three act on
the same store. Available calls:

- Reads: `readFile(path)` (utf8), `readFileBytes(path)` (returns a
  `Uint8Array`), `stat(path)`, `lstat(path)`, `exists(path)`,
  `readlink(path)`, `readdir(path)`, `find(dir, glob?)`,
  `ls(prefix)`, `grep(pattern, path, { ignoreCase? })`.
- Mutations: `writeFile(path, data)` (string or `Uint8Array`),
  `mkdir(path, { recursive })`, `rm(path, { recursive, force })`,
  `chmod(path, mode)`, `symlink(target, path)`.

The only filesystem operation left out is the streaming `readFile`
variant — a `ReadableStream` can't cross the sandbox boundary, so
codemode reads text through `readFile` and raw bytes through
`readFileBytes`.

The store the snippet touches is the same store `shell` and
`container` act on — one filesystem, three backends.

## Architecture

```
client ─► Worker ─┬─ /file, /exec   deterministic, no model
                  └─ /agent         model loop + exec tool
                         │  (stub RPC)
                         ▼
                  CodemodeExample DO   (owns fs + registers 3 backends)
                         ├─ shell     ─► Dynamic Worker (just-bash)
                         ├─ codemode  ─► Dynamic Worker (JS sandbox, state.*)
                         └─ container ─► Cloudflare Container (wsd)

           all file operations route back to the one DO's SQLite store
```

- The DO owns the filesystem: `Workspace` builds it over the DO's
  own `ctx.storage` (SQLite). That DO is the single source of truth.
- Backends are registered on the Workspace but **connect lazily** —
  a backend is dialed on its first `exec`, not at construction. The
  `container` backend's `connect()` is what boots the container, so
  registering it costs nothing until the first command routes to it.
- The `codemode` backend is co-located with the Workspace and needs
  no loopback proxy: the sandbox reaches the host through `state.*`
  RPC dispatchers, not a durable-object-namespace binding. The
  `shell` backend adds a `WorkspaceServiceProxy` loopback, and the
  `container` backend adds `withWorkspaceContainer` plus a
  `WorkspaceProxy` egress loopback.

## The optional agent layer

`POST /agent` runs the model loop **in the Worker**, reaching the
workspace through its stub. The loop builds an `exec` tool whose
`backend` parameter is an enum of `shell` / `codemode` / `container`;
the model reads each backend's description and picks one per call.

Keeping the loop in the Worker (rather than in the DO) is
deliberate: the workspace stays a plain workspace, and agency is
opt-in per request. The tradeoff is that a Worker-hosted loop is
bound by Worker CPU and wall-clock limits; a long-running agent
would promote the loop to its own durable object holding a workspace
stub, without changing the workspace itself.

The model is Workers AI Kimi (`@cf/moonshotai/kimi-k2.6`) via
`workers-ai-provider`, wired to the `AI` binding. The `/agent` route
needs an authenticated wrangler session (`npx wrangler login`);
`/file` and `/exec` are fully local.

## HTTP surface

```
PUT  /c/<name>/file/workspace/<path>   raw body → writeFile at /workspace/<path>
GET  /c/<name>/file/workspace/<path>   octet-stream of /workspace/<path>
                                       (any path outside /workspace returns 400)
POST /c/<name>/exec                    { command, cwd?, backend? }
                                       backend: shell | codemode | container
                                       (omit to use the default, shell)
                                       → JSON { exitCode, stdout, stderr }
POST /c/<name>/agent                   { prompt }
                                       → JSON { text, finishReason, steps, toolCalls }
```

`<name>` selects a workspace instance (durable object). Reuse a name
to share files across calls; use a new name for a clean slate.

## Run it locally

```sh
npm run dev --workspace @example/workspace-codemode
```

The first launch builds the container image (~1–2 min). If your
network intercepts TLS (a corporate proxy with its own certificate
authority), see [Container notes](#container-notes) — you can also
skip the container entirely:

```sh
# shell + codemode only, no Docker
npx wrangler dev --enable-containers=false
```

### Smoke test

The quickest check is the bundled script, which drives the file
surface and all three backends against a running `wrangler dev` and
fails loudly if the one shared filesystem is not consistent across
them:

```sh
./script/run                       # against http://127.0.0.1:8787
CONTAINERS=1 ./script/run          # also read from the container
AGENT=1 ./script/run               # also run one agent turn
```

To do the same steps by hand:

```sh
B=http://127.0.0.1:8787/c/demo

# codemode: command is JavaScript using state.*
# (the /workspace root is materialized on first use, so no mkdir)
curl -X POST $B/exec -H 'content-type: application/json' -d '{
  "command":"await state.writeFile(\"/workspace/hello.txt\",\"hello world\"); return await state.readFile(\"/workspace/hello.txt\");",
  "backend":"codemode"
}'

# shell: reads the SAME file codemode wrote (proves one shared fs)
curl -X POST $B/exec -H 'content-type: application/json' \
  -d '{"command":"cat /workspace/hello.txt","backend":"shell"}'

# container: real Linux userland (boots on first use)
curl -X POST $B/exec -H 'content-type: application/json' \
  -d '{"command":"uname -a; node --version","backend":"container"}'

# agent: the model picks the backend (needs `npx wrangler login`)
curl -X POST $B/agent -H 'content-type: application/json' -d '{
  "prompt":"Create /workspace/greeting.txt containing exactly the text hello world, then read it back to confirm. Report what you did."
}'
```

The `/agent` response includes `toolCalls[].backend`, showing which
backend the model chose for each command.

## Container notes

The image pulls `wsd` from a public GHCR image and installs a Linux
userland from Debian.

- **Node comes from Debian, not NodeSource.** The
  [`examples/container`](../container) image installs NodeSource's
  Node 22 over HTTPS, which fails behind a network that intercepts
  TLS with its own certificate authority (the `curl` in the Docker
  build aborts with a self-signed-certificate error, and the whole
  `wrangler dev` refuses to start). This image installs Debian's
  `nodejs`/`npm` over the plain-HTTP mirror instead, so it builds in
  those environments too. The tradeoff is an older Node.
- **Lazy boot.** The container starts on the first `exec` routed to
  the `container` backend, and the handle is cached after that, so
  only that first call pays any boot cost.
- **Apple Silicon.** The `wsd` base image is amd64-only, so on Apple
  Silicon the container runs under emulation and you'll see a
  harmless `InvalidBaseImagePlatform` warning.

## Tests

The backend has two test tiers, both under
`packages/workspace`:

```sh
# node unit tests (pure logic: state provider + exec-event mapping)
npx vitest run src/backends/codemode --workspace @cloudflare/workspace

# workerd integration tests (real Worker Loader + real Workspace)
npm run test:codemode-backend --workspace @cloudflare/workspace
```

The unit tests cover the `state.*` provider (positional args,
null-not-undefined returns, `exists` semantics, error propagation)
and the `ExecuteResult` → stdout/stderr/exit mapping (logs, return
values, the zero/false edge cases, errors). The integration tests
run real JavaScript snippets through the sandbox against a live
Workspace: output and exit codes, every `state.*` call, cross-checks
against the host filesystem, per-exec isolation, the no-network
guarantee, and `get()` returning `ENOENT`.

## Layout

```
examples/codemode/
  wrangler.jsonc    Worker + DO + worker_loaders + containers + AI
  Dockerfile        wsd + Debian userland for the container backend
  script/run        smoke test across the file surface + 3 backends
  src/index.ts      Worker handler + DO (CodemodeExample, 3 backends)
  src/agent.ts      the optional Workers AI model loop
  src/tools/exec.ts the exec tool advertised to the model
```

## Known limitations

- **Exec is run-and-collect.** Each backend emits at most one stdout
  and one stderr event per run; the handler awaits `handle.result()`
  and returns one JSON response.
- **`getExec` reattach is intentionally absent for codemode.** Each
  snippet runs to completion in its own isolate; an id can't be
  reached from a later request, so `get()` rejects with `ENOENT`.
- **Shell PATH-walk diagnostics in `wrangler dev`.** A `shell`
  command whose name matches a real Unix binary (`cat`, `ls`, …)
  makes just-bash probe every `$PATH` directory, and each miss
  prints `Uncaught WorkspaceFsError: no such path: ...`. Cosmetic;
  the command returns the correct result. The `codemode` backend
  doesn't do this (no `$PATH`), and `container` doesn't (real
  rootfs).
- **The file surface does not create parent directories.** A bare
  `Workspace` starts with an empty tree, and `PUT /file` maps to a
  single `writeFile`, so writing `a/b/c.txt` when `a/b` is absent
  rejects with `ENOENT`. The other examples avoid this for the mount
  root because registering a mount recursively creates its root; this
  example has no mount, so the durable object materializes
  `/workspace` itself on first use (see `#ensureRoot`). Deeper
  directories still need an explicit `state.mkdir(...)` or
  `mkdir -p`.
- **The agent loop runs in the Worker.** Fine for short tasks; a
  long agent run would want its own durable object.
