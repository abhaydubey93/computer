// Unit tests for stateProvider — the `state.*` namespace the
// codemode sandbox reaches the host filesystem through.
//
// These run under the plain node runner. The provider is pure glue
// over a WorkspaceFsLike, so a small recording fake stands in for
// the real WorkspaceFilesystem. The tests pin the two properties
// that matter for the RPC round trip: the fns are positional (a
// codemode call spreads its argument list back in), and void
// operations resolve to null rather than undefined so the result
// survives serialization back into the sandbox.

import { describe, expect, it } from "vitest";

import { stateProvider, type WorkspaceFsLike, type WorkspaceStatLike } from "./state-provider.js";

interface Call {
  fn: string;
  args: unknown[];
}

const STAT: WorkspaceStatLike = {
  name: "x.txt",
  inode: 7,
  mode: 0o644,
  mtime: 42,
  size: 3,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
};

// A ReadableStream that yields `bytes` in one chunk, for exercising
// the streaming readFile variant behind readFileBytes.
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// A WorkspaceFsLike that records every call and returns values the
// test configures. Each method pushes onto `calls` so a test can
// assert the provider forwarded exactly the arguments it received.
function fakeFs(overrides: Partial<WorkspaceFsLike> = {}): {
  fs: WorkspaceFsLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record =
    <T>(fn: string, value: T) =>
    (...args: unknown[]): Promise<T> => {
      calls.push({ fn, args });
      return Promise.resolve(value);
    };

  const fs: WorkspaceFsLike = {
    // readFile is overloaded: "utf8" yields text, no encoding yields
    // a byte stream (readFileBytes drains it host-side).
    readFile: ((path: string, encoding?: "utf8") => {
      calls.push({ fn: "readFile", args: encoding === undefined ? [path] : [path, encoding] });
      return Promise.resolve(
        encoding === "utf8" ? "file-contents" : bytesStream(new Uint8Array([104, 105])),
      );
    }) as WorkspaceFsLike["readFile"],
    stat: record("stat", STAT),
    lstat: record("lstat", { ...STAT, isSymbolicLink: true }),
    readlink: record("readlink", "/target"),
    readdir: record("readdir", [
      { name: "a.txt", parentPath: "/d", isFile: true, isDirectory: false, isSymbolicLink: false },
      { name: "b.txt", parentPath: "/d", isFile: true, isDirectory: false, isSymbolicLink: false },
    ]),
    find: record("find", [{ path: "/d/a.txt", type: "file" as const }]),
    ls: record("ls", ["a.txt", "b.txt"]),
    grep: record("grep", [{ path: "/d/a.txt", line: 2, text: "hit" }]),
    writeFile: record("writeFile", undefined),
    mkdir: record("mkdir", undefined),
    rm: record("rm", undefined),
    chmod: record("chmod", undefined),
    symlink: record("symlink", undefined),
    ...overrides,
  };
  return { fs, calls };
}

describe("stateProvider", () => {
  it("names the namespace 'state'", () => {
    const { fs } = fakeFs();
    expect(stateProvider(fs).name).toBe("state");
  });

  it("exposes exactly the expected fns", () => {
    const { fs } = fakeFs();
    const names = Object.keys(stateProvider(fs).fns).sort();
    expect(names).toEqual(
      [
        "chmod",
        "exists",
        "find",
        "grep",
        "ls",
        "lstat",
        "mkdir",
        "readFile",
        "readFileBytes",
        "readdir",
        "readlink",
        "rm",
        "stat",
        "symlink",
        "writeFile",
      ].sort(),
    );
  });

  it("readFile forwards the path positionally and always requests utf8", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.readFile("/workspace/x.txt");
    expect(out).toBe("file-contents");
    expect(calls).toEqual([{ fn: "readFile", args: ["/workspace/x.txt", "utf8"] }]);
  });

  it("readFileBytes drains the byte stream into a Uint8Array", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.readFileBytes("/workspace/x.bin");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([104, 105]);
    // No encoding argument — it takes the streaming overload.
    expect(calls).toEqual([{ fn: "readFile", args: ["/workspace/x.bin"] }]);
  });

  it("writeFile forwards (path, content) positionally and resolves to null", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.writeFile("/workspace/x.txt", "hi");
    // null, not undefined — undefined would vanish over the JSON
    // round trip back into the sandbox.
    expect(out).toBeNull();
    expect(calls).toEqual([{ fn: "writeFile", args: ["/workspace/x.txt", "hi"] }]);
  });

  it("writeFile passes a Uint8Array body through unchanged", async () => {
    const { fs, calls } = fakeFs();
    const bytes = new Uint8Array([1, 2, 3]);
    await stateProvider(fs).fns.writeFile("/b.bin", bytes);
    expect(calls[0].args[1]).toBe(bytes);
  });

  it("readdir maps entries down to their names", async () => {
    const { fs } = fakeFs();
    const out = await stateProvider(fs).fns.readdir("/workspace");
    expect(out).toEqual(["a.txt", "b.txt"]);
  });

  it("stat passes the stat record through", async () => {
    const { fs } = fakeFs();
    const out = await stateProvider(fs).fns.stat("/workspace/x.txt");
    expect(out).toEqual(STAT);
  });

  it("lstat forwards to lstat, not stat", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.lstat("/workspace/link");
    expect((out as WorkspaceStatLike).isSymbolicLink).toBe(true);
    expect(calls).toEqual([{ fn: "lstat", args: ["/workspace/link"] }]);
  });

  it("readlink returns the stored target", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.readlink("/workspace/link");
    expect(out).toBe("/target");
    expect(calls).toEqual([{ fn: "readlink", args: ["/workspace/link"] }]);
  });

  it("find forwards (directory, pattern) positionally", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.find("/workspace", "*.txt");
    expect(out).toEqual([{ path: "/d/a.txt", type: "file" }]);
    expect(calls).toEqual([{ fn: "find", args: ["/workspace", "*.txt"] }]);
  });

  it("find tolerates a missing pattern (passes undefined)", async () => {
    const { fs, calls } = fakeFs();
    await stateProvider(fs).fns.find("/workspace");
    expect(calls).toEqual([{ fn: "find", args: ["/workspace", undefined] }]);
  });

  it("ls returns the listing", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.ls("/workspace");
    expect(out).toEqual(["a.txt", "b.txt"]);
    expect(calls).toEqual([{ fn: "ls", args: ["/workspace"] }]);
  });

  it("grep forwards (pattern, path, options) positionally", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.grep("hit", "/workspace", { ignoreCase: true });
    expect(out).toEqual([{ path: "/d/a.txt", line: 2, text: "hit" }]);
    expect(calls).toEqual([{ fn: "grep", args: ["hit", "/workspace", { ignoreCase: true }] }]);
  });

  it("exists returns true when stat resolves", async () => {
    const { fs } = fakeFs();
    expect(await stateProvider(fs).fns.exists("/workspace/x.txt")).toBe(true);
  });

  it("exists returns false when stat throws ENOENT", async () => {
    const { fs } = fakeFs({
      stat: () => Promise.reject(Object.assign(new Error("no such path"), { code: "ENOENT" })),
    });
    expect(await stateProvider(fs).fns.exists("/missing")).toBe(false);
  });

  it("exists rethrows a non-ENOENT error rather than swallowing it", async () => {
    const { fs } = fakeFs({
      stat: () => Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" })),
    });
    await expect(stateProvider(fs).fns.exists("/x")).rejects.toThrow("permission denied");
  });

  it("mkdir forwards options and resolves to null", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.mkdir("/workspace/dir", { recursive: true });
    expect(out).toBeNull();
    expect(calls).toEqual([{ fn: "mkdir", args: ["/workspace/dir", { recursive: true }] }]);
  });

  it("rm forwards options and resolves to null", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.rm("/workspace/dir", { recursive: true, force: true });
    expect(out).toBeNull();
    expect(calls).toEqual([
      { fn: "rm", args: ["/workspace/dir", { recursive: true, force: true }] },
    ]);
  });

  it("chmod forwards (path, mode) positionally and resolves to null", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.chmod("/workspace/x.sh", 0o755);
    expect(out).toBeNull();
    expect(calls).toEqual([{ fn: "chmod", args: ["/workspace/x.sh", 0o755] }]);
  });

  it("symlink forwards (target, path) positionally and resolves to null", async () => {
    const { fs, calls } = fakeFs();
    const out = await stateProvider(fs).fns.symlink("/workspace/real", "/workspace/link");
    expect(out).toBeNull();
    expect(calls).toEqual([{ fn: "symlink", args: ["/workspace/real", "/workspace/link"] }]);
  });

  it("propagates a readFile rejection to the caller", async () => {
    const { fs } = fakeFs({
      readFile: (() =>
        Promise.reject(
          Object.assign(new Error("no such path"), { code: "ENOENT" }),
        )) as WorkspaceFsLike["readFile"],
    });
    await expect(stateProvider(fs).fns.readFile("/missing")).rejects.toThrow("no such path");
  });
});
