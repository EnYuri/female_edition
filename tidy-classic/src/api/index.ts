/**
 * Reconstructed barrel for `src/api`.
 *
 * Upstream had this file, but it is NOT in the published sourcemap: a barrel that only
 * re-exports produces no runtime code of its own, so the bundler folded it away and
 * `sourcesContent` never carried it. Surviving code still imports from `'src/api'`, so it
 * has to exist again.
 *
 * Scope is deliberately minimal. A sweep of every `import … from 'src/api'` in the tree
 * found exactly two VALUE imports — `TidyFlags` and `TidyHooks`; everything else was a
 * type-only import, which esbuild erases before resolution and which therefore never
 * needed this module at all. Re-exporting more than is imported would only invent API
 * surface that upstream may not have had.
 */
export { TidyFlags } from 'src/foundry/TidyFlags';
export { TidyHooks } from 'src/foundry/TidyHooks';
export { Tidy5eSheetsApi } from 'src/api/Tidy5eSheetsApi';
