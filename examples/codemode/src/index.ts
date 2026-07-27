// Example Worker + Durable Object that runs one Workspace with
// three backends, and an optional agent layer on top.
//
// The durable object owns the filesystem (SQLite) and registers
// three ways to run a command against it:
//
//   - "shell"    just-bash in a Dynamic Worker (WorkerBackend).
//   - "codemode" LLM-authored JavaScript in a Dynamic Worker
//                (CodemodeBackend), reaching the files through a
//                state.* namespace.
//   - "container" wsd in a Cloudflare Container
//                (CloudflareContainerBackend), a full Linux
//                userland. Boots on first use only.
//
// The workspace itself knows nothing about agents. Two HTTP
// surfaces sit on top of the same durable object:
//
//   - Deterministic, no model: PUT/GET /file and POST /exec.
//   - Optional agent: POST /agent runs a model loop that drives
//     the exec tool. The loop lives in the Worker and reaches the
//     workspace through its stub, so agency is opt-in per request
//     and the workspace stays a plain workspace.
//
// Wire shape:
//
//   client ─► Worker ─┬─ /file, /exec  deterministic, no model
//                     └─ /agent        model loop + exec tool
//                            │
//                            ▼   (stub RPC)
//                     CodemodeExample DO  (fs + 3 backends)
//                            ├─ shell     ─► Dynamic Worker (just-bash)
//                            ├─ codemode  ─► Dynamic Worker (JS sandbox)
//                            └─ container ─► Cloudflare Container (wsd)

import { DurableObject } from "cloudflare:workers";

import {
  type DurableObjectStorageLike,
  Workspace,
  type WorkspaceBackend,
  WorkspaceProxy,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/workspace";
import { CodemodeBackend } from "@cloudflare/workspace/backends/codemode";
import {
  CloudflareContainerBackend,
  withWorkspaceContainer,
} from "@cloudflare/workspace/backends/container";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";

import { runAgentTurn } from "./agent.js";
import type { ExecWorkspaceLike } from "./tools/exec.js";

// Re-export so the runtime can build the loopback bindings the
// durable object reaches through ctx.exports:
//   - WorkspaceProxy carries the container's outbound /ws upgrade
//     back to this durable object (container backend egress).
//   - WorkspaceServiceProxy is the Fetcher the worker backend hands
//     into its Dynamic Worker so the in-isolate shell can reach
//     back to getWorkspace().
export { WorkspaceProxy, WorkspaceServiceProxy };

// ---------------------------------------------------------------
// Durable Object: owns one Workspace with three backends.
// ---------------------------------------------------------------
export class CodemodeExample extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly #containerBackend: CloudflareContainerBackend;
  readonly #workspace: Workspace;
  // Cached so the mount root is materialized once per instance.
  #rootReady?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Both the worker and container backends reach back into this
    // durable object through a loopback keyed by {binding, id}.
    const workspaceRef = { binding: "CodemodeExample", id: ctx.id.toString() };

    this.#containerBackend = new CloudflareContainerBackend({
      id: "container",
      container: () => this,
      workspace: workspaceRef,
    });

    // Declared order sets the default (first) backend. "shell" is
    // the cheapest general-purpose backend, so it leads.
    //
    // The cast is a workaround, not a code smell: each element is a
    // WorkspaceBackend from this same library. With three backends
    // on top of the container mixin, checking the array against
    // WorkspaceBackend[] makes tsc walk the recursive capnweb
    // BackendHandle types past its instantiation-depth limit
    // (TS2589). Widening the elements up front sidesteps that walk.
    const backends = [
      new WorkerBackend({
        id: "shell",
        loader: env.LOADER,
        workspace: workspaceRef,
        ctx,
      }),
      new CodemodeBackend({
        id: "codemode",
        loader: env.LOADER,
        // Resolved lazily on first exec, after this Workspace is
        // fully constructed.
        workspace: () => this.#workspace,
      }),
      this.#containerBackend,
    ] as unknown as WorkspaceBackend[];

    this.#workspace = new Workspace({
      // ctx.storage.sql.exec returns a narrower row type than
      // DurableObjectStorageLike declares; the runtime shape
      // matches. Cast through unknown to bypass invariance.
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends,
    });
  }

  // ---- Worker-facing RPC surface --------------------------------

  // Returns an RpcTarget the caller uses to reach the Workspace.
  // Methods on the returned stub round-trip into this durable
  // object over Workers RPC.
  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    await this.#ensureRoot();
    return this.#workspace.stub();
  }

  // Materialize the /workspace mount root on a fresh instance.
  //
  // A new workspace starts with an empty tree, and the file surface
  // does not create parent directories, so the first
  // PUT /file/workspace/<path> would reject with ENOENT. The other
  // examples never hit this because they mount an R2 bucket under
  // /workspace, and registering a mount runs the same recursive
  // mkdir on its root. This example has no mount, so it does that
  // one mkdir itself. Recursive, so it is idempotent; cached, so it
  // runs once per instance rather than on every request.
  #ensureRoot(): Promise<void> {
    this.#rootReady ??= this.#workspace.fs.mkdir("/workspace", { recursive: true });
    return this.#rootReady;
  }

  // ---- WebSocket: the container's outbound /ws upgrade -----------

  override async fetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }
}

// ---------------------------------------------------------------
// Worker HTTP surface
// ---------------------------------------------------------------

interface ExecRequest {
  command?: string;
  cwd?: string;
  backend?: string;
}

interface AgentRequest {
  prompt?: string;
}

const MOUNT_ROOT = "/workspace";

function resolveMountPath(rest: string): string | null {
  const candidate = `/${rest}`;
  if (candidate !== MOUNT_ROOT && !candidate.startsWith(`${MOUNT_ROOT}/`)) {
    return null;
  }
  if (candidate.split("/").includes("..")) return null;
  return candidate;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const fileMatch = url.pathname.match(/^\/c\/([^/]+)\/file\/(.+)$/);
    if (fileMatch) {
      const resolved = resolveMountPath(fileMatch[2]);
      if (resolved === null) {
        return errorJSON(new Error(`path must sit under ${MOUNT_ROOT}; got /${fileMatch[2]}`), 400);
      }
      return handleFile(request, env, fileMatch[1], resolved);
    }

    const execMatch = url.pathname.match(/^\/c\/([^/]+)\/exec\/?$/);
    if (execMatch) return handleExec(request, env, execMatch[1]);

    const agentMatch = url.pathname.match(/^\/c\/([^/]+)\/agent\/?$/);
    if (agentMatch) return handleAgent(request, env, agentMatch[1]);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "codemode example",
          "",
          `  PUT  /c/<name>/file/workspace/<path>     write file at ${MOUNT_ROOT}/<path>`,
          `  GET  /c/<name>/file/workspace/<path>     read file at ${MOUNT_ROOT}/<path>`,
          "  POST /c/<name>/exec                      run one command (JSON result)",
          "                                           body: { command, cwd?, backend? }",
          "                                           backend: shell | codemode | container",
          "  POST /c/<name>/agent                     run an agent turn (JSON transcript)",
          "                                           body: { prompt }",
          "",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleFile(
  request: Request,
  env: Env,
  name: string,
  path: string,
): Promise<Response> {
  const stub = env.CodemodeExample.get(env.CodemodeExample.idFromName(name));
  const ws = await stub.getWorkspace();

  if (request.method === "PUT") {
    const body = new Uint8Array(await request.arrayBuffer());
    try {
      await ws.fs.writeFile(path, body);
      return new Response(null, { status: 204 });
    } catch (error) {
      return errorJSON(error, 500);
    }
  }

  if (request.method === "GET") {
    try {
      const stream = await ws.fs.readFile(path, {});
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ENOENT") return errorJSON(error, 404);
      return errorJSON(error, 500);
    }
  }

  return new Response("method not allowed", { status: 405, headers: { allow: "GET, PUT" } });
}

async function handleExec(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let body: ExecRequest;
  try {
    body = (await request.json()) as ExecRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }

  if (typeof body.command !== "string" || body.command.length === 0) {
    return errorJSON(new Error("must provide command"), 400);
  }

  const stub = env.CodemodeExample.get(env.CodemodeExample.idFromName(name));
  const ws = await stub.getWorkspace();
  try {
    const handle = await ws.shell.exec(body.command, {
      cwd: body.cwd,
      encoding: "utf8",
      backend: body.backend,
    });
    const result = await handle.result();
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return errorJSON(error, 500);
  }
}

async function handleAgent(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  let body: AgentRequest;
  try {
    body = (await request.json()) as AgentRequest;
  } catch {
    return errorJSON(new Error("invalid JSON body"), 400);
  }
  if (typeof body.prompt !== "string" || body.prompt.length === 0) {
    return errorJSON(new Error("must provide prompt"), 400);
  }

  const stub = env.CodemodeExample.get(env.CodemodeExample.idFromName(name));
  const ws = await stub.getWorkspace();
  try {
    // The workspace stub drives the exec tool. Its exec/result
    // methods behave exactly like a local Workspace at runtime, but
    // the capnweb stub wraps them in promise-pipelined types that
    // don't structurally match the plain ExecWorkspaceLike the tool
    // declares. Cast at this one boundary.
    const transcript = await runAgentTurn({
      env,
      workspace: ws as unknown as ExecWorkspaceLike,
      prompt: body.prompt,
    });
    return new Response(JSON.stringify(transcript), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    return errorJSON(error, 500);
  }
}

function errorJSON(error: unknown, status: number): Response {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
