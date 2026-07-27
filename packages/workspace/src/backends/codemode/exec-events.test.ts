// Unit tests for the ExecuteResult -> ExecEvent translation.
//
// This is where the codemode backend decides what a run's stdout,
// stderr, and exit code look like, so it is the most bug-prone
// corner of the backend. The tests run under the plain node runner
// against the pure helpers; no workerd, no Worker Loader.

import type { ExecuteResult } from "@cloudflare/codemode";
import type { ExecEvent } from "@cloudflare/workspace-rpc";
import { describe, expect, it } from "vitest";

import { execEventStream, joinStdout, renderResult } from "./exec-events.js";

async function drain(stream: ReadableStream<ExecEvent>): Promise<ExecEvent[]> {
  const out: ExecEvent[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const decoder = new TextDecoder();

// Convenience: run a result through the stream and return a plain
// {stdout, stderr, exitCode} the way WorkspaceShell would fold it.
async function fold(
  outcome: ExecuteResult,
): Promise<{ stdout: string; stderr: string; exitCode: number; events: ExecEvent[] }> {
  const events = await drain(execEventStream("run-1", outcome));
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  for (const e of events) {
    if (e.name === "stdout") stdout += decoder.decode(e.value as Uint8Array);
    else if (e.name === "stderr") stderr += decoder.decode(e.value as Uint8Array);
    else if (e.name === "exit") exitCode = e.value as number;
  }
  return { stdout, stderr, exitCode, events };
}

describe("renderResult", () => {
  it("passes a string through verbatim", () => {
    expect(renderResult("hello world")).toBe("hello world");
  });

  it("renders null and undefined as empty", () => {
    expect(renderResult(null)).toBe("");
    expect(renderResult(undefined)).toBe("");
  });

  it('renders the number zero as "0", not empty', () => {
    // Regression guard: 0 is falsy, but a snippet returning 0 must
    // still print it.
    expect(renderResult(0)).toBe("0");
  });

  it('renders false as "false"', () => {
    expect(renderResult(false)).toBe("false");
  });

  it("renders an empty string as empty", () => {
    expect(renderResult("")).toBe("");
  });

  it("JSON-encodes objects and arrays", () => {
    expect(renderResult({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}');
    expect(renderResult([1, "two", true])).toBe('[1,"two",true]');
  });

  it("renders a non-serializable value as empty rather than crashing", () => {
    // JSON.stringify returns undefined for a bare function or symbol;
    // renderResult must not leak that undefined (it would blow up
    // joinStdout's .length check).
    expect(renderResult(() => 1)).toBe("");
    expect(renderResult(Symbol("x"))).toBe("");
  });
});

describe("joinStdout", () => {
  it("returns empty when there is nothing to show", () => {
    expect(joinStdout(undefined, undefined)).toBe("");
    expect(joinStdout([], null)).toBe("");
  });

  it("returns just the logs when there is no result", () => {
    expect(joinStdout(["one", "two"], undefined)).toBe("one\ntwo");
  });

  it("returns just the result when there are no logs", () => {
    expect(joinStdout(undefined, "result")).toBe("result");
    expect(joinStdout([], "result")).toBe("result");
  });

  it("puts logs first, then the result, newline-joined", () => {
    expect(joinStdout(["log a", "log b"], 42)).toBe("log a\nlog b\n42");
  });
});

describe("execEventStream", () => {
  it("emits stdout then exit 0 for a plain string result", async () => {
    const { stdout, stderr, exitCode } = await fold({ result: "hello world" });
    expect(stdout).toBe("hello world");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  it("emits console output as stdout", async () => {
    const { stdout, exitCode } = await fold({ logs: ["line one", "line two"], result: undefined });
    expect(stdout).toBe("line one\nline two");
    expect(exitCode).toBe(0);
  });

  it("combines logs and the return value on stdout", async () => {
    const { stdout, exitCode } = await fold({ logs: ["log line"], result: 42 });
    expect(stdout).toBe("log line\n42");
    expect(exitCode).toBe(0);
  });

  it("emits stderr and exit 1 for an error", async () => {
    const { stdout, stderr, exitCode } = await fold({ error: "boom" });
    expect(stdout).toBe("");
    expect(stderr).toBe("boom\n");
    expect(exitCode).toBe(1);
  });

  it("keeps logs on stdout even when the run errors", async () => {
    const { stdout, stderr, exitCode } = await fold({ logs: ["progress"], error: "boom" });
    expect(stdout).toBe("progress");
    expect(stderr).toBe("boom\n");
    expect(exitCode).toBe(1);
  });

  it("emits no stdout event for an empty successful run", async () => {
    const { stdout, stderr, exitCode, events } = await fold({ result: null });
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    // Exactly one event: the exit. No empty stdout chunk.
    expect(events.map((e) => e.name)).toEqual(["exit"]);
  });

  it("numbers events sequentially and tags them with the run id", async () => {
    const { events } = await fold({ logs: ["a"], error: "b" });
    expect(events.map((e) => e.name)).toEqual(["stdout", "stderr", "exit"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.id === "run-1")).toBe(true);
  });

  it("renders a structured return value as JSON on stdout", async () => {
    const { stdout, exitCode } = await fold({ result: { ok: true, items: [1, 2] } });
    expect(stdout).toBe('{"ok":true,"items":[1,2]}');
    expect(exitCode).toBe(0);
  });

  it("renders a zero return value rather than dropping it", async () => {
    const { stdout, exitCode } = await fold({ result: 0 });
    expect(stdout).toBe("0");
    expect(exitCode).toBe(0);
  });
});
