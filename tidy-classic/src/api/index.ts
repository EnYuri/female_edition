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
 * surface that upstream may not have had. The `export type` entries below restore only
 * the barrel types surviving code imports; they erase before bundling and pull in no
 * runtime modules.
 */
export { TidyFlags } from 'src/foundry/TidyFlags';
export { TidyHooks } from 'src/foundry/TidyHooks';
export { Tidy5eSheetsApi } from 'src/api/Tidy5eSheetsApi';
export type {
  CustomHeaderControlsEntry,
  ItemTabRegistrationOptions,
  PortraitMenuCommand,
  SheetHeaderControlPosition,
  TabEnabledCallbackFunctionOverrideOptions,
  TabIdDocumentItemTypesOptions,
  TabIdDocumentItemTypesParams,
} from './api.types';
export type { CustomTabTitle } from './tab/CustomTabBase';
export type { CustomTraitEntry } from './config/actor-traits/types';
export type {
  EncounterCombatantSettings,
  EncounterCombatantsSettings,
  SheetPinFlag,
} from 'src/foundry/TidyFlags.types';
