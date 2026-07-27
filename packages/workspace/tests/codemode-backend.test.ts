// End-to-end integration tests for the CodemodeBackend.
//
// Runs inside the real workerd through vitest-pool-workers, so every
// layer is real: the Worker Loader binding, the codemode
// DynamicWorkerExecutor minting a throwaway sandbox isolate per
// exec, the state.* dispatchers, and the fs round-trip back into the
// host Durable Object. A passing run proves the backend holds
// together end to end, not just that the unit-level fakes line up.
//
//   test              driver Worker            HostDO
//     │  SELF.fetch       │                       │
//     ├──────────────────►│  HOST.get(id).exec    │
//     │                   ├──────────────────────►│  Workspace.shell.exec
//     │                   │                       ├──► CodemodeBackend
//     │                   │                       │      │ env.LOADER.load(...)
//     │                   │                       │      ▼
//     │                   │                       │   sandbox isolate (JS)
//     │                   │                       │      │ state.* over RPC
//     │                   │                       │◄─────┘ (lands in this DO)

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Env } from "./codemode-backend-worker.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

let counter = 0;
function freshId(): string {
  return `case-${++counter}`;
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function exec(id: string, command: string): Promise<ExecResult> {
  const url = new URL("http://test/exec");
  url.searchParams.set("id", id);
  const res = await SELF.fetch(url, { method: "POST", body: command });
  if (!res.ok) throw new Error(`exec failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function writeViaFs(id: string, path: string, body: string): Promise<void> {
  const url = new URL("http://test/write");
  url.searchParams.set("id", id);
  url.searchParams.set("path", path);
  const res = await SELF.fetch(url, { method: "POST", body });
  if (!res.ok) throw new Error(`write failed: ${res.status} ${await res.text()}`);
}

async function readViaFs(id: string, path: string): Promise<{ status: number; text: string }> {
  const url = new URL("http://test/read");
  url.searchParams.set("id", id);
  url.searchParams.set("path", path);
  const res = await SELF.fetch(url);
  return { status: res.status, text: await res.text() };
}

async function tryGet(id: string, execId: string): Promise<{ ok: boolean; code?: string }> {
  const url = new URL("http://test/get");
  url.searchParams.set("id", id);
  url.searchParams.set("execId", execId);
  const res = await SELF.fetch(url);
  return res.json();
}

describe("CodemodeBackend end-to-end", () => {
  describe("output and exit code", () => {
    it("puts a string return value on stdout with exit 0", async () => {
      const r = await exec(freshId(), 'return "hello world";');
      expect(r).toEqual({ exitCode: 0, stdout: "hello world", stderr: "" });
    });

    it("puts console.log output on stdout", async () => {
      const r = await exec(freshId(), 'console.log("logged line");');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("logged line");
    });

    it("combines console.log and the return value on stdout", async () => {
      const r = await exec(freshId(), 'console.log("log line"); return 42;');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("log line\n42");
    });

    it("sends a thrown error to stderr and exits 1", async () => {
      const r = await exec(freshId(), 'throw new Error("boom");');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("boom");
    });

    it("returns empty stdout and exit 0 for a snippet that returns nothing", async () => {
      const r = await exec(freshId(), "const x = 1 + 1;");
      expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    });

    it("renders the number zero rather than dropping it", async () => {
      const r = await exec(freshId(), "return 0;");
      expect(r).toEqual({ exitCode: 0, stdout: "0", stderr: "" });
    });

    it("renders a structured return value as JSON", async () => {
      const r = await exec(freshId(), "return { ok: true, items: [1, 2, 3] };");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('{"ok":true,"items":[1,2,3]}');
    });

    it("handles large output without truncating in the backend", async () => {
      const r = await exec(freshId(), 'return "x".repeat(100000);');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.length).toBe(100000);
    });
  });

  describe("state.* filesystem access", () => {
    it("writes then reads a file back within one snippet", async () => {
      const r = await exec(
        freshId(),
        'await state.mkdir("/workspace", { recursive: true }); await state.writeFile("/workspace/a.txt", "hello world"); return await state.readFile("/workspace/a.txt");',
      );
      expect(r).toEqual({ exitCode: 0, stdout: "hello world", stderr: "" });
    });

    it("reads a file the host wrote through the live filesystem", async () => {
      const id = freshId();
      await writeViaFs(id, "/workspace/from-host.txt", "written by host");
      const r = await exec(id, 'return await state.readFile("/workspace/from-host.txt");');
      expect(r).toEqual({ exitCode: 0, stdout: "written by host", stderr: "" });
    });

    it("a file the sandbox writes is visible to the host filesystem", async () => {
      const id = freshId();
      const w = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true }); await state.writeFile("/workspace/from-sandbox.txt", "written by sandbox"); return "done";',
      );
      expect(w.exitCode).toBe(0);
      const read = await readViaFs(id, "/workspace/from-sandbox.txt");
      expect(read.status).toBe(200);
      expect(read.text).toBe("written by sandbox");
    });

    it("reports a missing file as an error (exit 1)", async () => {
      const r = await exec(freshId(), 'return await state.readFile("/workspace/missing.txt");');
      expect(r.exitCode).toBe(1);
      expect(r.stderr.length).toBeGreaterThan(0);
    });

    it("state.exists reflects presence and absence", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true }); await state.writeFile("/workspace/here.txt", "x"); const a = await state.exists("/workspace/here.txt"); const b = await state.exists("/workspace/nope.txt"); return JSON.stringify([a, b]);',
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("[true,false]");
    });

    it("state.readdir lists directory entries by name", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace/d", { recursive: true }); await state.writeFile("/workspace/d/one.txt", "1"); await state.writeFile("/workspace/d/two.txt", "2"); const names = await state.readdir("/workspace/d"); return JSON.stringify(names.sort());',
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('["one.txt","two.txt"]');
    });

    it("state.stat reports file metadata", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true }); await state.writeFile("/workspace/s.txt", "abcde"); const st = await state.stat("/workspace/s.txt"); return JSON.stringify({ isFile: st.isFile, isDirectory: st.isDirectory, size: st.size });',
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ isFile: true, isDirectory: false, size: 5 });
    });

    it("state.rm deletes a file", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true }); await state.writeFile("/workspace/gone.txt", "x"); await state.rm("/workspace/gone.txt"); return await state.exists("/workspace/gone.txt");',
      );
      // exists returns false -> renders as empty stdout, exit 0.
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("false");
    });
  });

  describe("state.* extended surface", () => {
    it("readFileBytes round-trips binary through the codec both ways", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true });' +
          " await state.writeFile('/workspace/b.bin', new Uint8Array([0, 1, 2, 254, 255]));" +
          " const bytes = await state.readFileBytes('/workspace/b.bin');" +
          " return JSON.stringify({ ctor: bytes.constructor.name, arr: Array.from(bytes) });",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ ctor: "Uint8Array", arr: [0, 1, 2, 254, 255] });
    });

    it("readFileBytes returns the utf8 bytes of a text file", async () => {
      const id = freshId();
      await writeViaFs(id, "/workspace/hi.txt", "hi");
      const r = await exec(
        id,
        "const b = await state.readFileBytes('/workspace/hi.txt'); return JSON.stringify(Array.from(b));",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([104, 105]);
    });

    it("symlink + lstat + readlink describe the link; stat follows it", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true });' +
          " await state.writeFile('/workspace/real.txt', 'hello');" +
          " await state.symlink('/workspace/real.txt', '/workspace/link.txt');" +
          " const l = await state.lstat('/workspace/link.txt');" +
          " const s = await state.stat('/workspace/link.txt');" +
          " const target = await state.readlink('/workspace/link.txt');" +
          " return JSON.stringify({ linkIsSymlink: l.isSymbolicLink, statIsFile: s.isFile, target });",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        linkIsSymlink: true,
        statIsFile: true,
        target: "/workspace/real.txt",
      });
    });

    it("find matches a top-level glob under the start directory", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace/proj", { recursive: true });' +
          " await state.writeFile('/workspace/proj/a.js', 'x');" +
          " await state.writeFile('/workspace/proj/b.txt', 'y');" +
          " const found = await state.find('/workspace/proj', '*.js');" +
          " return JSON.stringify(found.map((e) => e.path).sort());",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual(["/workspace/proj/a.js"]);
    });

    it("ls returns the flat list of file paths under a prefix", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace/tree/sub", { recursive: true });' +
          " await state.writeFile('/workspace/tree/one.txt', '1');" +
          " await state.writeFile('/workspace/tree/sub/two.txt', '2');" +
          " const out = await state.ls('/workspace/tree');" +
          " return JSON.stringify(out.sort());",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([
        "/workspace/tree/one.txt",
        "/workspace/tree/sub/two.txt",
      ]);
    });

    it("grep finds a case-insensitive match with its 1-indexed line", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true });' +
          " await state.writeFile('/workspace/g.txt', 'alpha\\nBeta\\ngamma\\n');" +
          " const hits = await state.grep('beta', '/workspace/g.txt', { ignoreCase: true });" +
          " return JSON.stringify(hits.map((h) => ({ line: h.line, text: h.text })));",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([{ line: 2, text: "Beta" }]);
    });

    it("chmod changes the stored mode bits", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true });' +
          " await state.writeFile('/workspace/x.sh', '#!/bin/sh\\n');" +
          " await state.chmod('/workspace/x.sh', 0o755);" +
          " const st = await state.stat('/workspace/x.sh');" +
          " return (st.mode & 0o777).toString(8);",
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("755");
    });

    it("find matches a nested ** glob, including the top level", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace/proj/src/deep", { recursive: true });' +
          " await state.writeFile('/workspace/proj/a.ts', 'x');" +
          " await state.writeFile('/workspace/proj/src/b.ts', 'y');" +
          " await state.writeFile('/workspace/proj/src/deep/c.ts', 'z');" +
          " await state.writeFile('/workspace/proj/note.md', 'm');" +
          " const found = await state.find('/workspace/proj', '**/*.ts');" +
          " return JSON.stringify(found.map((e) => e.path).sort());",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([
        "/workspace/proj/a.ts",
        "/workspace/proj/src/b.ts",
        "/workspace/proj/src/deep/c.ts",
      ]);
    });

    it("readFileBytes round-trips a large binary buffer intact", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true });' +
          " const n = 100000; const src = new Uint8Array(n);" +
          " for (let i = 0; i < n; i++) src[i] = i % 256;" +
          " await state.writeFile('/workspace/big.bin', src);" +
          " const back = await state.readFileBytes('/workspace/big.bin');" +
          " return JSON.stringify({ len: back.length, first: back[0], mid: back[50000], last: back[n - 1] });",
      );
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ len: 100000, first: 0, mid: 80, last: 159 });
    });
  });

  describe("state.* error paths", () => {
    it("readlink on a non-symlink fails with a not-a-symlink error (exit 1)", async () => {
      const id = freshId();
      const r = await exec(
        id,
        'await state.mkdir("/workspace", { recursive: true });' +
          " await state.writeFile('/workspace/plain.txt', 'x');" +
          " return await state.readlink('/workspace/plain.txt');",
      );
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("not a symlink");
    });

    it("readFileBytes on a missing file fails with no-such-path (exit 1)", async () => {
      const r = await exec(freshId(), "return await state.readFileBytes('/workspace/nope.bin');");
      expect(r.exitCode).toBe(1);
      // readFile's ENOENT message reads "no such file"; the metadata
      // ops say "no such path". Match the common stem.
      expect(r.stderr).toContain("no such");
    });

    it("chmod on a missing path fails with no-such-path (exit 1)", async () => {
      const r = await exec(freshId(), "return await state.chmod('/workspace/nope.txt', 0o644);");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("no such path");
    });

    it("find on a missing directory fails with no-such-path (exit 1)", async () => {
      const r = await exec(freshId(), "return await state.find('/workspace/does-not-exist');");
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("no such path");
    });

    it("ls on a missing path resolves to an empty listing rather than throwing", async () => {
      const r = await exec(
        freshId(),
        "const out = await state.ls('/workspace/does-not-exist'); return JSON.stringify(out);",
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("[]");
    });
  });

  describe("isolation and lifecycle", () => {
    it("gives each exec a fresh isolate with no shared globals", async () => {
      const id = freshId();
      const first = await exec(id, "globalThis.__leak = 123; return 'set';");
      expect(first).toEqual({ exitCode: 0, stdout: "set", stderr: "" });
      const second = await exec(id, "return typeof globalThis.__leak;");
      expect(second).toEqual({ exitCode: 0, stdout: "undefined", stderr: "" });
    });

    it("cannot reach the public internet (globalOutbound is null)", async () => {
      const r = await exec(
        freshId(),
        'try { const res = await fetch("https://example.com"); return "reached:" + res.status; } catch (e) { return "blocked"; }',
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("blocked");
    });

    it("rejects a get() for an unknown exec id with ENOENT", async () => {
      const r = await tryGet(freshId(), "does-not-exist");
      expect(r.ok).toBe(false);
      expect(r.code).toBe("ENOENT");
    });

    it("runs independent workspaces without cross-talk", async () => {
      const a = freshId();
      const b = freshId();
      await exec(
        a,
        'await state.mkdir("/workspace", { recursive: true }); await state.writeFile("/workspace/shared.txt", "from-a"); return "ok";',
      );
      // b is a different DO id; it must not see a's file.
      const r = await exec(b, 'return await state.exists("/workspace/shared.txt");');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("false");
    });
  });
});
