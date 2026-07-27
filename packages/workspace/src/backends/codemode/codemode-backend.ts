// CodemodeBackend — backs Workspace with a codemode sandbox that
// runs an LLM-authored JavaScript snippet in a Dynamic Worker
// minted through env.LOADER.
//
// Unlike the worker and container backends, which run shell
// commands, this backend runs code: `shell.exec(command)` treats
// `command` as JavaScript, executes it through
// @cloudflare/codemode's DynamicWorkerExecutor, and reports the
// snippet's return value plus console output as stdout, with a
// non-zero exit code when it throws. The snippet reaches the
// filesystem through a `state.*` namespace wired to the host
// Workspace (see state-provider.ts), so it acts on the same store
// the other backends do.
//
// The backend is co-located: it runs inside the same Durable
// Object that owns the Workspace, so `connect()` builds the
// ShellRPC as a plain in-process object — there is no wire and no
// capnweb session. Each exec mints a fresh, isolated sandbox
// through env.LOADER with `globalOutbound: null`, so a snippet has
// no way to reach the public internet on its own.
//
// Because there's no second store, the BackendHandle declares
// sync: "none". Workspace.push and Workspace.pull short-circuit;
// reconcileWatermarks on connect is skipped.

import type { DynamicWorkerExecutorOptions } from "@cloudflare/codemode";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import type { ShellRPC, SyncRPC, WorkspaceRPC } from "@cloudflare/workspace-rpc";

import type { BackendHandle, WorkspaceBackend } from "../../backend.js";
import { execEventStream } from "./exec-events.js";
import { stateProvider, type WorkspaceFsLike } from "./state-provider.js";

// The host Workspace this backend operates on. Passed as a thunk
// because the backend is constructed before the Workspace it
// belongs to — the Workspace constructor takes the backend list, so
// the reference can't exist yet. The thunk is resolved lazily in
// connect(), by which point the Workspace is fully constructed.
export interface CodemodeWorkspaceHost {
  fs: WorkspaceFsLike;
}

export interface CodemodeBackendOptions {
  // The Worker Loader binding from env. The backend mints the
  // sandbox Dynamic Worker through it, one throwaway isolate per
  // exec.
  loader: DynamicWorkerExecutorOptions["loader"];

  // Resolves the host Workspace whose filesystem the sandbox acts
  // on. Called once on connect(); see CodemodeWorkspaceHost for why
  // it's a thunk.
  workspace: () => CodemodeWorkspaceHost;

  // Selector this backend is registered under in Workspace.
  // Defaults to "codemode"; override when the workspace hosts more
  // than one instance of the same backend kind.
  id?: string;
}

export class CodemodeBackend implements WorkspaceBackend {
  readonly type = "codemode";
  readonly id: string;
  readonly #options: CodemodeBackendOptions;

  constructor(options: CodemodeBackendOptions) {
    this.id = options.id ?? "codemode";
    this.#options = options;
  }

  async connect(): Promise<BackendHandle> {
    const loader = this.#options.loader;
    const provider = stateProvider(this.#options.workspace().fs);

    const shell: ShellRPC = {
      async exec(input) {
        const id = input.id ?? crypto.randomUUID();
        // A fresh executor per exec so a per-call timeout maps onto
        // the isolate's timeout. globalOutbound stays at its default
        // (null) — the snippet reaches the host only through state.*.
        const executor = new DynamicWorkerExecutor({ loader, timeout: input.timeoutMs });
        const outcome = await executor.execute(input.command, [provider]);
        return { id, events: execEventStream(id, outcome) };
      },
      async getExec(input) {
        // Each exec runs to completion inside exec() and owns no
        // durable log; an id is never reachable from a later call.
        // Return ENOENT so consumers see a consistent failure shape.
        throw createShellError("ENOENT", `no such exec: ${input.id}`);
      },
      async killExec() {
        // The snippet runs synchronously to completion inside
        // exec(); by the time a caller could observe an id the run
        // has already settled. Nothing to kill.
      },
      async disposeExec() {
        // No DB-backed log to dispose; the event stream is the only
        // resource and it ends with the run. A no-op keeps the
        // WorkspaceShell surface uniform.
      },
    };

    const rpc: WorkspaceRPC = { sync: noopSync(), shell };

    return {
      rpc,
      sync: "none",
      close: async () => {
        // Nothing to tear down. Each exec's isolate is discarded
        // when the run settles; there is no persistent session.
      },
    };
  }
}

function createShellError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = "CodemodeBackendError";
  error.code = code;
  return error;
}

function noopSync(): SyncRPC {
  const refuse = (name: string): never => {
    throw new Error(
      `CodemodeBackend: sync.${name} must not be called — the handle declares sync: "none"`,
    );
  };
  return {
    push: () => refuse("push") as never,
    fetchChanges: () => refuse("fetchChanges") as never,
    readEntry: () => refuse("readEntry") as never,
    hasObjects: () => refuse("hasObjects") as never,
    fetchObjects: () =>
      new ReadableStream({
        start(c) {
          c.error(new Error("CodemodeBackend: sync.fetchObjects must not be called"));
        },
      }),
    pushObjects: () => refuse("pushObjects") as never,
    watermarks: () => refuse("watermarks") as never,
  };
}
