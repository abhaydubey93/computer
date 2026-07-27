// Workerd test harness for the CodemodeBackend integration tests.
//
// Two exports:
//
//   - HostDO — the host Durable Object. Owns one Workspace whose
//     only backend is a CodemodeBackend dialing through env.LOADER.
//     Exposes exec (run a JavaScript snippet through the codemode
//     sandbox), plus writeFile / readFile / tryGet helpers the test
//     calls through the DO stub so it can cross-check what the
//     sandbox did against the live Workspace filesystem.
//   - default — a tiny WorkerEntrypoint that routes incoming
//     fetches into the DO, so the test drives everything through
//     SELF.fetch.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { CodemodeBackend } from "../src/backends/codemode/index.js";
import type { DurableObjectStorageLike } from "../src/index.js";
import { Workspace } from "../src/index.js";

export interface Env {
  HOST: DurableObjectNamespace<HostDO>;
  LOADER: WorkerLoader;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class HostDO extends DurableObject<Env> {
  readonly #workspace: Workspace;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#workspace = new Workspace({
      storage: ctx.storage as unknown as DurableObjectStorageLike,
      backends: [
        new CodemodeBackend({
          loader: env.LOADER,
          workspace: () => this.#workspace,
        }),
      ],
    });
  }

  // Run an LLM-authored JavaScript snippet through the codemode
  // sandbox and fold its event stream into a plain result.
  async exec(command: string): Promise<ExecResult> {
    const handle = await this.#workspace.shell.exec(command, { encoding: "utf8" });
    const result = await handle.result();
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  // Write straight through the live filesystem (not the sandbox), so
  // a test can prove the sandbox reads what the host wrote.
  async writeFile(path: string, body: string): Promise<void> {
    await this.#workspace.fs.mkdir("/workspace", { recursive: true });
    await this.#workspace.fs.writeFile(path, body);
  }

  // Read straight through the live filesystem, to prove the host
  // sees what the sandbox wrote.
  async readFile(path: string): Promise<string> {
    return this.#workspace.fs.readFile(path, "utf8");
  }

  // Attempt to reattach to an exec by id. The codemode backend keeps
  // no durable log, so this must reject; the test asserts the error
  // code.
  async tryGet(id: string): Promise<{ ok: boolean; code?: string; message?: string }> {
    try {
      await this.#workspace.shell.get(id, { encoding: "utf8" });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: (error as { code?: string }).code,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export default class extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? "default";
    const stub = this.env.HOST.get(this.env.HOST.idFromName(id));

    if (url.pathname === "/exec") {
      const command =
        request.method === "POST" ? await request.text() : (url.searchParams.get("command") ?? "");
      const result = await stub.exec(command);
      return Response.json(result);
    }

    if (url.pathname === "/write") {
      const path = url.searchParams.get("path") ?? "/workspace/note.txt";
      const body = await request.text();
      await stub.writeFile(path, body);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/read") {
      const path = url.searchParams.get("path") ?? "/workspace/note.txt";
      try {
        const text = await stub.readFile(path);
        return new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
      } catch (error) {
        const code = (error as { code?: string }).code;
        return new Response(String(error), { status: code === "ENOENT" ? 404 : 500 });
      }
    }

    if (url.pathname === "/get") {
      const execId = url.searchParams.get("execId") ?? "missing";
      return Response.json(await stub.tryGet(execId));
    }

    return new Response("not found", { status: 404 });
  }
}
