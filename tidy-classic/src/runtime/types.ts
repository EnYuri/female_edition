/**
 * Type-only stub for `src/runtime/types`.
 *
 * The original module declared nothing but types, so it produced no runtime code and
 * the bundler never emitted it — which means the published sourcemap has no copy of it
 * and the real declarations are unrecoverable. Importers still name these symbols, and
 * esbuild keeps an import it cannot prove is type-only, so the module has to resolve.
 *
 * Types are erased before execution, so `any` here changes nothing at runtime; it only
 * makes type checking permissive.
 */

export type BankedInspirationConfiguration = any;
export type ColumnCellProps = any;
export type ColumnHeaderProps = any;
export type ColumnSpecDocumentTypesToTabs = any;
export type ColumnSpecification = any;
export type ColumnSpecificationCalculatedWidthArgs = any;
export type ConfiguredColumnSpecification = any;
export type ContainerContentsRowActionsContext = any;
export type CustomTraitEnabledParams = any;
export type DefaultTableColumns = any;
export type GetConfiguredColumnSpecificationsArgs = any;
export type RegisteredContent = any;
export type RegisteredCustomActorTrait = any;
export type RegisteredItemSummaryCommand = any;
export type RegisteredPortraitMenuCommand = any;
export type RegisteredPortraitMenuCommandExecuteParams = any;
export type RegisteredSectionCommand = any;
export type RegisteredSectionCommandEnabledParams = any;
export type RegisteredSectionCommandExecuteParams = any;
export type RegisteredTab = any;
export type SheetLayout = any;
