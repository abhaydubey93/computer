import { describe, expect, it } from "vitest";
import { createExecTool, type ExecToolInput, type ExecWorkspaceLike } from "./exec.js";

interface ExecCall {
  command: string;
  cwd: string | undefined;
  backend: string | undefined;
  writable: boolean | undefined;
}

function fakeWorkspace(
  result: { exitCode: number; stdout: string; stderr: string } | Error = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  },
): ExecWorkspaceLike & { calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    runtime: {
      async exec(command, options) {
        calls.push({
          command,
          cwd: options.cwd,
          backend: options.backend,
          writable: options.writable,
        });
        if (result instanceof Error) throw result;
        return { result: async () => result };
      },
    },
  };
}

function toolFor(
  workspace: ExecWorkspaceLike,
  writable?: (input: ExecToolInput) => boolean,
): ReturnType<typeof createExecTool> {
  return createExecTool({
    workspace,
    backends: { shell: { description: "a shell" }, container: { description: "a container" } },
    defaultBackend: "shell",
    writable,
  });
}

// The `ai` package types execute as optional and pass a second
// argument the tool ignores.
async function run(
  tool: ReturnType<typeof createExecTool>,
  input: { command: string; cwd?: string; backend?: string },
): Promise<Record<string, unknown>> {
  const execute = tool.execute as (i: typeof input, o: unknown) => Promise<Record<string, unknown>>;
  return execute(input, {});
}

describe("createExecTool — write access", () => {
  it("runs commands with write access when no resolver is configured", async () => {
    const ws = fakeWorkspace();
    await run(toolFor(ws), { command: "npm test" });
    expect(ws.calls[0].writable).toBe(true);
  });

  it("asks the resolver and forwards its answer", async () => {
    const ws = fakeWorkspace();
    const tool = toolFor(ws, ({ command }) => !command.startsWith("git log"));

    await run(tool, { command: "git log --oneline" });
    await run(tool, { command: "npm install" });

    expect(ws.calls.map((c) => c.writable)).toEqual([false, true]);
  });

  it("shows the resolver the resolved backend, not the model's selector", async () => {
    // The resolver's decision often depends on where the command
    // runs, since that determines whether a refused write is
    // prevented or only reported afterwards.
    const seen: ExecToolInput[] = [];
    const ws = fakeWorkspace();
    const tool = toolFor(ws, (input) => {
      seen.push(input);
      return true;
    });

    await run(tool, { command: "ls" });
    await run(tool, { command: "ls", backend: "container", cwd: "/workspace/sub" });

    expect(seen).toEqual([
      { command: "ls", cwd: undefined, backend: "shell" },
      { command: "ls", cwd: "/workspace/sub", backend: "container" },
    ]);
  });

  it("does not accept write access as model input", async () => {
    // The model must not classify its own command. If it could, the
    // command mislabelled as read-only — the case this exists to
    // catch — would arrive labelled read-only and be trusted.
    const ws = fakeWorkspace();
    const tool = toolFor(ws, () => false);

    await run(tool, { command: "rm -rf /", writable: true } as never);

    expect(ws.calls[0].writable).toBe(false);
  });

  it("keeps write access out of the input schema entirely", async () => {
    const tool = toolFor(fakeWorkspace());
    const schema = tool.inputSchema as { shape?: Record<string, unknown> };
    expect(Object.keys(schema.shape ?? {})).toEqual(["command", "cwd", "backend"]);
  });

  it("reports the write access it ran with on a success", async () => {
    // So the model can tell a refused write from a broken command;
    // otherwise its next move is to retry the same thing.
    const ws = fakeWorkspace({ exitCode: 1, stdout: "", stderr: "read-only access\n" });
    const output = await run(
      toolFor(ws, () => false),
      { command: "touch f" },
    );

    expect(output.writable).toBe(false);
    expect(output.exitCode).toBe(1);
    expect(output.stderr).toContain("read-only access");
  });

  it("returns a refused command as a tool result rather than throwing", async () => {
    // A gate denial arrives as a thrown error. Returning it keeps the
    // agent loop alive and lets the model read why it was refused.
    const ws = fakeWorkspace(new Error("shell.exec denied: not on the allowlist"));
    const output = await run(toolFor(ws), { command: "rm -rf /" });

    expect(output.error).toBe("shell.exec denied: not on the allowlist");
    expect(output.writable).toBe(true);
  });
});
