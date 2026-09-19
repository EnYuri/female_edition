/**
 * Type-only stub for `src/settings/settings.types`.
 *
 * The original module declared nothing but types, so it produced no runtime code and
 * the bundler never emitted it — which means the published sourcemap has no copy of it
 * and the real declarations are unrecoverable. Importers still name these symbols, and
 * esbuild keeps an import it cannot prove is type-only, so the module has to resolve.
 *
 * Types are erased before execution, so `any` here changes nothing at runtime; it only
 * makes type checking permissive.
 */

export type GlobalCustomSectionsetting = any;
export type HeaderControlConfiguration = any;
export type SheetTabConfiguration = any;
export type TabConfiguration = any;
