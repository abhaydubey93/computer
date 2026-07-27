// Pure translation from a codemode ExecuteResult into the
// ExecEvent stream WorkspaceShell consumes.
//
// This file holds no runtime dependency on @cloudflare/codemode —
// the ExecuteResult and ExecEvent imports are type-only — so the
// logic that decides what lands on stdout, what lands on stderr,
// and what exit code a run reports can be unit-tested under the
// plain node runner without booting workerd or a Worker Loader.
//
// The mapping: console output and the snippet's return value join
// into stdout; a thrown error becomes stderr plus a non-zero exit
// code. An empty stdout produces no stdout event at all, so a
// consumer sees "" rather than a stray empty chunk.

import type { ExecuteResult } from "@cloudflare/codemode";
import type { ExecEvent } from "@cloudflare/workspace-rpc";

export function execEventStream(id: string, outcome: ExecuteResult): ReadableStream<ExecEvent> {
  const encoder = new TextEncoder();
  const events: ExecEvent[] = [];
  let seq = 0;

  const stdout = joinStdout(outcome.logs, outcome.result);
  if (stdout.length > 0) {
    events.push({ id, seq: ++seq, name: "stdout", value: encoder.encode(stdout) });
  }
  if (outcome.error !== undefined) {
    events.push({ id, seq: ++seq, name: "stderr", value: encoder.encode(`${outcome.error}\n`) });
  }
  events.push({ id, seq: ++seq, name: "exit", value: outcome.error !== undefined ? 1 : 0 });

  return new ReadableStream<ExecEvent>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
}

// Join captured console output and the rendered return value into
// one stdout string. Logs come first, in the order they were
// emitted, then the return value on its own line. Either part is
// omitted when empty, so a snippet that only logs, or only returns,
// or does neither, produces the natural output.
export function joinStdout(logs: string[] | undefined, result: unknown): string {
  const parts: string[] = [];
  if (logs !== undefined && logs.length > 0) parts.push(logs.join("\n"));
  const rendered = renderResult(result);
  if (rendered.length > 0) parts.push(rendered);
  return parts.join("\n");
}

// Render a snippet's return value for stdout. A string passes
// through verbatim; null and undefined render as nothing (a snippet
// with no explicit return should not print "undefined"); everything
// else is JSON so structured returns survive as readable text.
export function renderResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result) ?? "";
}
