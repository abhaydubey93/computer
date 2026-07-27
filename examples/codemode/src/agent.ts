/**
 * The optional agent layer.
 *
 * This module is deliberately separate from the durable object that
 * owns the workspace. The workspace is just a filesystem with a few
 * backends; nothing about it depends on a model. `runAgentTurn`
 * bolts a model loop on top: it builds the `exec` tool over a
 * workspace handle (a live Workspace or a stub — either works) and
 * runs one agentic turn.
 *
 * Because the loop only needs a handle that exposes `shell.exec`,
 * the agent can run anywhere: here it runs inside the Worker fetch
 * handler and reaches the workspace through its stub, so the
 * workspace durable object never has to know an agent exists.
 */

import { generateText, stepCountIs } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { createExecTool, type ExecWorkspaceLike } from "./tools/exec.js";

// The Workers AI model that drives the loop. Kimi K2.6 handles tool
// calling and has a large context window.
const MODEL_ID = "@cf/moonshotai/kimi-k2.6";

// Plenty of budget for a write-then-read loop, with a ceiling so a
// confused model can't spin forever.
const MAX_STEPS = 12;

export interface AgentTurnOptions {
  env: Env;
  workspace: ExecWorkspaceLike;
  prompt: string;
}

export interface AgentToolCall {
  backend: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentTranscript {
  text: string;
  finishReason: string;
  steps: number;
  toolCalls: AgentToolCall[];
}

const SYSTEM_PROMPT = [
  "You are an agent working inside a workspace with a filesystem",
  "mounted at /workspace. You act on the files only through the",
  "`exec` tool.",
  "",
  "The `exec` tool exposes three backends. Read its per-backend",
  "descriptions and pick the one that fits each command:",
  "",
  "- shell: a fast shell for text tools and git.",
  "- codemode: runs JavaScript against the files through a state.*",
  "  namespace. Use it when a task is easiest expressed as code,",
  "  for example reading a file and returning its contents, or",
  "  computing a value and writing it out. The /workspace directory",
  "  may not exist yet, so create it first with",
  '  `await state.mkdir("/workspace", { recursive: true })`.',
  "- container: a full Linux userland for real binaries; slow to",
  "  boot, so reach for it only when the lighter backends can't run",
  "  the command.",
  "",
  "When the task is done, reply with a short plain-text summary of",
  "what you did.",
].join("\n");

export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTranscript> {
  const workersai = createWorkersAI({ binding: opts.env.AI });
  const model = workersai(MODEL_ID);

  const exec = createExecTool({
    workspace: opts.workspace,
    maxBytes: 16 * 1024,
    backends: {
      shell: {
        description:
          "just-bash in a Dynamic Worker. Cold-start fast, no " +
          "container, no public network. Good for cat / grep / sed / " +
          "awk / head / tail / sort / find and `git`. `command` is a " +
          "shell line. Cannot run npm, node, python, or any binary " +
          "outside just-bash's built-in command set.",
      },
      codemode: {
        description:
          "Runs JavaScript in a Dynamic Worker. `command` is a " +
          "JavaScript snippet, not a shell line. It reaches the " +
          "workspace files through an async `state.*` namespace. " +
          "Reads: state.readFile(path) (utf8), state.readFileBytes(path) " +
          "(Uint8Array), state.stat(path), state.lstat(path), " +
          "state.exists(path), state.readlink(path), state.readdir(path), " +
          "state.find(dir, glob?), state.ls(prefix), " +
          "state.grep(pattern, path, { ignoreCase }). Mutations: " +
          "state.writeFile(path, data), state.mkdir(path, { recursive }), " +
          "state.rm(path, { recursive, force }), state.chmod(path, mode), " +
          "state.symlink(target, path). The snippet's return value and any " +
          "console.log output become stdout; a thrown error becomes " +
          "stderr with exit code 1. Use for file work and logic that " +
          "reads cleanly as code.",
      },
      container: {
        description:
          "Cloudflare Container running wsd. Full Linux userland: " +
          "npm, node, real binaries on PATH, public network. " +
          "`command` is a shell line. Cold start is slow (container " +
          "boot); reach for it only when shell can't run the command.",
      },
    },
    defaultBackend: "shell",
  });

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: opts.prompt,
    tools: { exec },
    stopWhen: stepCountIs(MAX_STEPS),
  });

  const toolCalls: AgentToolCall[] = [];
  for (const step of result.steps) {
    for (const tr of step.toolResults) {
      const output = tr.output as {
        backend?: string;
        command?: string;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      toolCalls.push({
        backend: output.backend ?? "",
        command: output.command ?? "",
        exitCode: output.exitCode ?? -1,
        stdout: output.stdout ?? "",
        stderr: output.stderr ?? "",
      });
    }
  }

  return {
    text: result.text,
    finishReason: result.finishReason,
    steps: result.steps.length,
    toolCalls,
  };
}
