// Public surface of @cloudflare/workspace/backends/codemode.
//
// The codemode backend pairs a Workspace with a codemode sandbox
// that runs an LLM-authored JavaScript snippet in a Dynamic Worker
// minted through env.LOADER. The snippet reaches the host
// filesystem through a `state.*` namespace, so it acts on the same
// store the worker and container backends do — one filesystem, many
// backends.
//
// Imported via:
//
//   import { CodemodeBackend } from "@cloudflare/workspace/backends/codemode";

export {
  CodemodeBackend,
  type CodemodeBackendOptions,
  type CodemodeWorkspaceHost,
} from "./codemode-backend.js";
export { stateProvider, type WorkspaceFsLike } from "./state-provider.js";
