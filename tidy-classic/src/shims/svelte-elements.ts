/**
 * Runtime shim for `svelte/elements`.
 *
 * Svelte publishes that subpath as TYPES ONLY — its package export is
 * `{ "types": "./elements.d.ts" }` with no runtime entry — so Rollup reports
 * "No known conditions for './elements' specifier in 'svelte' package" the moment a bare
 * import of it survives. Every use in this tree is `import type`, but the type specifiers
 * are stripped ahead of resolution and a side-effect import can be left behind.
 *
 * Aliased in vite.config.ts so that leftover import resolves to this empty module. Types
 * still come from Svelte's own `elements.d.ts` through tsconfig, so editor and
 * `svelte-check` behaviour is unchanged.
 */
export {};
