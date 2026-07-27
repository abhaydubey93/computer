// stateProvider — exposes the host Workspace filesystem to
// sandboxed codemode scripts as a `state.*` namespace.
//
// The codemode backend runs an LLM-authored JavaScript snippet in
// an isolated Dynamic Worker. The snippet reaches the outside
// world only through the tool namespaces the executor injects; this
// provider is the one namespace the codemode backend hands it. Each
// `state.readFile(...)` call in the sandbox dispatches over Workers
// RPC back to the fns defined here, which run host-side in the
// Durable Object and forward straight to the live WorkspaceFilesystem.
// The store the snippet touches is therefore the same store the
// worker and container backends act on — one filesystem, many
// backends.
//
// The namespace mirrors the filesystem surface the worker (shell)
// backend already exposes to just-bash: there is no security
// boundary to defend by keeping codemode smaller, because the agent
// picks the backend and every backend acts on the same store. The
// only calls left out are the ones that cannot cross the sandbox
// boundary as-is — the streaming `readFile` variant returns a
// ReadableStream, so codemode reads text through `readFile` and raw
// bytes through `readFileBytes` instead.
//
// The fns are positional: codemode serializes a call's argument
// list and spreads it back into the fn, so `state.writeFile("/a",
// "hi")` arrives here as `writeFile("/a", "hi")`. Void operations
// return `null` rather than `undefined` so the result survives the
// round trip back into the sandbox. Binary payloads survive too:
// codemode's transport codec tags Uint8Array / ArrayBuffer values
// as base64, so `writeFile` accepts bytes and `readFileBytes`
// returns them.

import type { ResolvedProvider } from "@cloudflare/codemode";

// Stat record surfaced by `state.stat` / `state.lstat`. Matches the
// dofs WorkspaceStatResult; declared structurally so this file does
// not depend on the concrete dofs types.
export interface WorkspaceStatLike {
  name: string;
  inode: number;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

// One entry from `WorkspaceFilesystem.readdir`.
export interface WorkspaceDirentLike {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

// One entry from `WorkspaceFilesystem.find`.
export interface WorkspaceFoundLike {
  path: string;
  type: "file" | "dir";
}

// One match from `WorkspaceFilesystem.grep`.
export interface WorkspaceGrepLike {
  path: string;
  line: number;
  text: string;
}

// The subset of WorkspaceFilesystem the provider consumes. Declared
// structurally so this file doesn't depend on the concrete dofs
// class — the live `Workspace.fs` satisfies it, and tests can pass a
// fake with the same shape.
export interface WorkspaceFsLike {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<WorkspaceStatLike>;
  lstat(path: string): Promise<WorkspaceStatLike>;
  readlink(path: string): Promise<string>;
  readdir(path: string): Promise<WorkspaceDirentLike[]>;
  find(directory: string, pattern?: string): Promise<WorkspaceFoundLike[]>;
  ls(prefix: string): Promise<string[]>;
  grep(
    pattern: string,
    path: string,
    options?: { ignoreCase?: boolean },
  ): Promise<WorkspaceGrepLike[]>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}

// The namespace the snippet sees. `state.readFile("/x")` and so on.
const NAMESPACE = "state";

// Drain a byte stream into a single Uint8Array, host-side. The
// streaming readFile variant can't cross the sandbox boundary, so
// readFileBytes reads it here and hands the sandbox the bytes, which
// the codemode codec tags as base64 on the way in.
async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function stateProvider(fs: WorkspaceFsLike): ResolvedProvider {
  return {
    name: NAMESPACE,
    fns: {
      // --- Reads ---------------------------------------------------
      readFile: (path) => fs.readFile(path as string, "utf8"),
      readFileBytes: async (path) => streamToBytes(await fs.readFile(path as string)),
      stat: (path) => fs.stat(path as string),
      lstat: (path) => fs.lstat(path as string),
      exists: async (path) => {
        try {
          await fs.stat(path as string);
          return true;
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") return false;
          throw error;
        }
      },
      readlink: (path) => fs.readlink(path as string),
      readdir: async (path) => {
        const entries = await fs.readdir(path as string);
        return entries.map((entry) => entry.name);
      },
      find: (directory, pattern) => fs.find(directory as string, pattern as string | undefined),
      ls: (prefix) => fs.ls(prefix as string),
      grep: (pattern, path, options) =>
        fs.grep(pattern as string, path as string, options as { ignoreCase?: boolean } | undefined),

      // --- Mutations -----------------------------------------------
      writeFile: async (path, content) => {
        await fs.writeFile(path as string, content as string | Uint8Array);
        return null;
      },
      mkdir: async (path, options) => {
        await fs.mkdir(path as string, options as { recursive?: boolean } | undefined);
        return null;
      },
      rm: async (path, options) => {
        await fs.rm(
          path as string,
          options as { recursive?: boolean; force?: boolean } | undefined,
        );
        return null;
      },
      chmod: async (path, mode) => {
        await fs.chmod(path as string, mode as number);
        return null;
      },
      symlink: async (target, path) => {
        await fs.symlink(target as string, path as string);
        return null;
      },
    },
  };
}
