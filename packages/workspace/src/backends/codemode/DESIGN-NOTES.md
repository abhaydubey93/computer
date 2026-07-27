# Codemode backend design notes

Running notes on where the codemode backend and its example differ
from the worker and container backends. The goal is to record a
choice and the reason for it, so the divergence is not a surprise
later. Newest notes go at the bottom.

## The command is JavaScript, not a shell line

The worker and container backends take a shell command and run it
with `just-bash` or `wsd`. The codemode backend treats the command
string as JavaScript. It runs the snippet in a dynamic worker
through `DynamicWorkerExecutor`. The return value and anything the
snippet sends to `console.log` become stdout; a thrown error becomes
stderr with exit code 1.

This is why `just-bash` is not involved here. `just-bash` is the
worker backend's shell. Codemode is a separate path that runs
model-authored JavaScript.

## No `WorkspaceServiceProxy` or `ctx.exports` loopback

The worker backend hands the dynamic worker a durable object
namespace binding so the sandbox can call back into the host
workspace. A durable object namespace cannot survive structured
clone, so the worker example wraps it with `WorkspaceServiceProxy`
and reaches it through `ctx.exports`.

The codemode backend needs none of that. The sandbox reaches the
host through remote procedure call dispatchers that the executor
passes as arguments to the snippet, not through a binding in the
sandbox's `env`. The `state.*` functions are plain closures in the
durable object that the dispatcher calls. So the example durable
object is smaller than the worker one: it constructs the workspace
and returns a stub, and that is all. No re-export, no proxy, no
`ctx.exports`.

## The backend and the workspace live in the same durable object

The container backend talks to a separate container over a socket,
so it runs a real synchronization loop to keep the two file systems
in agreement. The codemode backend runs in the same durable object
as the workspace it acts on. `connect()` returns a plain in-process
remote procedure call object, and synchronization is set to `none`
because there are not two copies of anything to reconcile.

## The workspace reference is a thunk

The workspace constructor takes the backend list, so a backend is
built before the workspace it belongs to exists. The backend can't
hold a direct reference at construction time. Instead the caller
passes `workspace: () => this.#workspace`, and the backend calls the
thunk once inside `connect()`, by which point the workspace is fully
built.

## One throwaway isolate per exec

Each call to `exec` builds a fresh `DynamicWorkerExecutor` and loads
a new isolate through the loader binding. There is no long-lived
sandbox process to reattach to. `globalOutbound` stays at its
default of `null`, so a snippet cannot reach the network; its only
door to the outside is the `state.*` namespace.

## `getExec`, `killExec`, and `disposeExec` are near no-ops

The worker and container backends can reattach to a running command
by id, kill it, or dispose it. A codemode exec runs to completion
inside the single `exec` call and keeps no durable log, so an id is
never reachable from a later call. `getExec` throws `ENOENT` to give
consumers a consistent failure shape. `killExec` and `disposeExec`
do nothing.

## Provider functions take positional arguments

On codemode 0.5.x a resolved provider is `{ name, fns, prelude? }`
with no separate argument descriptor. The sandbox serializes the
whole argument array and spreads it into the provider function, so
the `state.*` functions are written to take positional arguments,
for example `writeFile(path, data)` rather than an options object.

## The `state.*` surface mirrors the shell backend's

The provider exposes the whole filesystem surface the worker (shell)
backend already reaches through its just-bash adapter: reads
(`readFile`, `readFileBytes`, `stat`, `lstat`, `exists`, `readlink`,
`readdir`, `find`, `ls`, `grep`) and mutations (`writeFile`, `mkdir`,
`rm`, `chmod`, `symlink`). Keeping codemode smaller than shell would
not contain anything — the agent picks the backend, and every backend
acts on the same store, so a narrower `state.*` is not a security
boundary, only a smaller API.

Two shape choices fall out of the sandbox boundary:

- `readFile` returns utf8 text and `readFileBytes` returns a
  `Uint8Array`. The underlying `WorkspaceFilesystem.readFile` can also
  return a `ReadableStream`, but a stream cannot cross the host↔sandbox
  call boundary, so `readFileBytes` drains it into bytes host-side.
  Binary survives the trip because codemode's transport codec tags
  `Uint8Array` / `ArrayBuffer` values as base64 in both directions;
  the same tagging lets `writeFile` accept a `Uint8Array` body.
- `stat` and `lstat` pass the dofs stat record straight through
  (`mode`, `mtime`, `size`, the `is*` flags, and so on); the fields
  are plain scalars, so no shaping is needed.

## `/workspace` is not created for you

A fresh workspace has no `/workspace` directory. A snippet that
writes to `/workspace/hello.txt` before the directory exists fails
with `parent directory missing`. Create the directory first, for
example `await state.mkdir("/workspace", { recursive: true })`, or
write under a path whose parent already exists.

## A workspace is not agentic; agency is a layer on top

A workspace is a filesystem plus a set of backends. It knows
nothing about models or agents. That separation is deliberate: we
want every workspace to have the option of being driven by an
agent, without every workspace paying for one.

The example keeps this line clean. The `CodemodeExample` durable
object owns the filesystem and the backends and exposes plain,
deterministic routes (`PUT`/`GET /file`, `POST /exec`). None of it
mentions a model. The agent is a separate layer: `POST /agent`
runs a model loop in the Worker that reaches the workspace through
its stub and drives the `exec` tool. Agency is opt-in per request,
and the workspace has no dependency on any agent code.

The loop can reach the workspace through its stub because the
`exec` tool only needs something with `shell.exec`, which the stub
satisfies. Running the loop in the Worker keeps the workspace
durable object free of model concerns. The tradeoff is that a
Worker-hosted loop is bound by Worker CPU and wall-clock limits;
for a long-running agent, promote the loop to its own durable
object that holds a workspace stub. The workspace itself does not
change either way.

One typing wrinkle falls out of driving the workspace through its
stub. The stub's `exec` and `result` behave like a local
`Workspace` at runtime, but capnweb wraps them in
promise-pipelined types that do not structurally match the plain
`ExecWorkspaceLike` interface the tool declares. The example casts
at that one boundary. An agent that holds a local `Workspace`
instead (the way the think example does) needs no cast.

## Backends connect lazily, so the container costs nothing until used

The example registers three backends: `shell` (worker), `codemode`,
and `container`. A workspace dials a backend on its first
`exec`, not at construction, and caches the handle after that. The
container backend's `connect()` is what boots the Cloudflare
Container, so registering it is free — the container starts only
the first time an `exec` routes to `container`, and never if the
model never picks it. This is what lets the example advertise a
heavy backend as an always-available option without paying its
startup cost on every workspace.

## The codemode backend needs no container plumbing

Registering `container` alongside `shell` and `codemode` pulls in
real host wiring: the durable object mixes in `withWorkspaceContainer`,
re-exports `WorkspaceProxy` for container egress, and forwards the
container's `/ws` upgrade through `fetch`. The `shell` backend adds
its own `WorkspaceServiceProxy` loopback. The codemode backend adds
none of this. It reaches the host through the `state.*` dispatchers
described above, so it rides on the same durable object with no
extra bindings, no image, and no loopback proxy.

## Three backends plus the container mixin hit a type-depth limit

With three backends registered on a durable object that also mixes
in `withWorkspaceContainer`, `tsc` walks the recursive capnweb
`BackendHandle` types past its instantiation-depth limit and
reports TS2589. Two backends (the think example) stay under the
limit. The example widens the backend array to `WorkspaceBackend[]`
through a cast to stop the walk; the elements are all backends from
this library, so the cast asserts nothing untrue.

Separately, the example's `tsconfig.json` lists only the generated
`worker-configuration.d.ts` in `types`, not `@cloudflare/workers-types`
as well. Loading both pulls in two copies of the runtime globals
(`Fetcher`, `WorkerLoader`, and friends), and reconciling the two
copies is enough on its own to trip the same TS2589 during backend
construction. `wrangler types` prints this same advice.

## The shell backend logs harmless "no such path" stats

Running a shell command like `cat /workspace/hello.txt` on the
`shell` backend succeeds (exit code 0, correct output) but prints a
few `WorkspaceFsError: no such path` lines to the dev console, one
per entry like `/usr/bin/cat`, `/bin/cat`, `/usr/bin`.

This is `just-bash` resolving the command name. Before it uses its
built-in `cat`, it walks `$PATH` looking for an external `cat`
binary and stats each candidate. The workspace filesystem is not a
Linux rootfs — it holds only what you put under `/workspace` — so
every probe misses and the filesystem throws. `just-bash` catches
each miss, finds no binary, and falls back to the builtin, which is
why the command still succeeds.

The misses surface as "Uncaught" because each one is thrown across
the RPC boundary between the shell isolate and the workspace durable
object, and the runtime logs any rejection it sees crossing that
boundary even though `just-bash` handles it on its side.

Two backends avoid the noise. The `codemode` backend calls
`state.readFile` directly, with no `$PATH` walk, so its logs stay
clean. The `container` backend runs against a real Debian rootfs
where `/usr/bin/cat` exists, so the probe hits instead of missing.
The noise is specific to shell commands whose name matches a real
Unix binary. It is cosmetic; the workspace's `observer` option could
downgrade these expected stats if the noise ever gets in the way.

## The container image installs Node from Debian, not NodeSource

The `examples/container` image adds NodeSource's build of Node 22,
which it fetches over HTTPS from `deb.nodesource.com`. That fetch
fails behind a network that intercepts TLS with its own certificate
authority: the `curl` inside the Docker build aborts with a
self-signed-certificate error, and because the whole image build
fails, `wrangler dev` refuses to start rather than run without the
container. Everything else in the build uses the Debian mirror over
plain HTTP, which those networks pass through untouched.

The `examples/codemode` image installs Debian's own `nodejs` and
`npm` packages instead, so the image builds in those environments.
The tradeoff is an older Node (Debian stable ships Node 20 rather
than 22), which is fine for exercising the container backend. If you
are on an unfiltered network and want NodeSource's newer Node, the
`examples/container` Dockerfile shows that variant.

With this image the container backend runs under `wrangler dev`:
booting the container on the first exec routed to `container`,
mounting the same workspace tree through wsd's userspace shim, so a
file written through `codemode` is visible to `cat` in the
container, and `node --version` reports the Debian build.
