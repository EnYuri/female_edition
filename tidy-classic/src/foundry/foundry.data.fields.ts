/**
 * Stub for the ambient `foundry.data.fields` module.
 *
 * Upstream declared this in a `.d.ts`, which emits nothing and so never appeared in the
 * published sourcemap. Every import of it in this tree is type-only — the runtime code
 * reaches the real classes through the `foundry.data.fields.*` GLOBAL, never through the
 * import — but esbuild keeps a bare `import 'foundry.data.fields'` behind after stripping
 * the type specifiers, and Rollup then fails to resolve it.
 *
 * Aliased in vite.config.ts so that bare import resolves here and disappears.
 */
export type DataField = any;
export type DataFieldOptions = any;
export type DocumentUUIDField = any;
export type DocumentUUIDFieldOptions = any;
export type FormInputConfig = any;
export type NumberField = any;
export type NumberFieldOptions = any;
export type SetField = any;
export type StringField = any;
export type StringFieldOptions = any;
export type BooleanField = any;
