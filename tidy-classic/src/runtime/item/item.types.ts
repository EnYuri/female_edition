/**
 * Type-only stub for `src/runtime/item/item.types`.
 *
 * The original module declared nothing but types, so it produced no runtime code and
 * the bundler never emitted it — which means the published sourcemap has no copy of it
 * and the real declarations are unrecoverable. Importers still name these symbols, and
 * esbuild keeps an import it cannot prove is type-only, so the module has to resolve.
 *
 * Types are erased before execution, so `any` here changes nothing at runtime; it only
 * makes type checking permissive.
 */

export type ConfiguredItemFilter = any;
export type DocumentFilters = any;
export type DocumentTypesToFilterTabs = any;
export type DocumentTypesToSortMethodTabs = any;
export type FilterCategoriesToFilters = any;
export type FilterTabsToCategories = any;
export type ItemFilter = any;
export type RegisteredEquipmentTypeGroup = any;
