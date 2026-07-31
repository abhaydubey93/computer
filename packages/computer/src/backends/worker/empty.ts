// Empty shell-module group. Alias a
// @cloudflare/computer/shell/<feature> subpath to this module
// (published as @cloudflare/computer/empty) in wrangler.jsonc to
// drop that feature's chunks from the uploaded Worker.

export default Object.freeze({}) as Readonly<Record<string, { js: string }>>;
