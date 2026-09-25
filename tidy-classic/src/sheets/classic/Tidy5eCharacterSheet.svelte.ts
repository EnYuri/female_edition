import { FoundryAdapter } from '../../foundry/foundry-adapter';
import CharacterSheet from './character/CharacterSheet.svelte';
import { debug } from 'src/utils/logging';
import { settings } from 'src/settings/settings.svelte';
import { initTidy5eContextMenu } from 'src/context-menu/tidy5e-context-menu';
import { CONSTANTS } from 'src/constants';
import {
  type CharacterSheetContext,
  type SheetStats,
  type Actor5e,
  type SheetTabCacheable,
  type SheetExpandedItemsCacheable,
  type SearchFilterCacheable,
  type LocationToSearchTextMap,
  type ExpandedItemIdToLocationsMap,
  type ExpandedItemData,
  type Utilities,
  type ActiveEffect5e,
  type ActorInventoryTypes,
  type ActionItemInclusionMode,
  type CharacterItemPartitions,
  type CharacterFeatureSection,
  type CharacterItemContext,
  type SpellbookSection,
  type EffectFavoriteSection,
  type FacilitySection,
  type ActivitySection,
} from 'src/types/types';
import { mount } from 'svelte';
import type { Item5e, ItemChatData } from 'src/types/item.types';
import CharacterSheetClassicRuntime from 'src/runtime/actor/CharacterSheetClassicRuntime.svelte';
import {
  actorUsesActionFeature,
  getCharacterSheetTabActionSections,
  isItemInActionList,
} from 'src/features/actions/actions.svelte';
import { isNil } from 'src/utils/data';
import { CustomActorTraitsRuntime } from 'src/runtime/actor-traits/CustomActorTraitsRuntime';
import { ItemTableToggleCacheService } from 'src/features/caching/ItemTableToggleCacheService';
import { UserSheetPreferencesService } from 'src/features/user-preferences/SheetPreferencesService';
import { CharacterSheetSections } from 'src/features/sections/CharacterSheetSections';
import { SheetSections } from 'src/features/sections/SheetSections';
import { DocumentTabSectionConfigApplication } from 'src/applications/section-config/DocumentTabSectionConfigApplication.svelte';
import { Inventory } from 'src/features/sections/Inventory';
import type {
  CharacterFavorite,
  UnsortedCharacterFavorite,
} from 'src/foundry/dnd5e.types';
import { TidyHooks } from 'src/foundry/TidyHooks';
import { TidyFlags } from 'src/foundry/TidyFlags';
import { Container } from 'src/features/containers/Container';
import { InlineToggleService } from 'src/features/expand-collapse/InlineToggleService.svelte';
import { ConditionsAndEffects } from 'src/features/conditions-and-effects/ConditionsAndEffects';
import { Activities } from 'src/features/activities/activities';
import { ExpansionTracker } from 'src/features/expand-collapse/ExpansionTracker.svelte';
import { SheetPinsProvider } from 'src/features/sheet-pins/SheetPinsProvider';
import { ItemContext } from 'src/features/item/ItemContext';
import * as Bastion from 'src/features/facility/Bastion';
import { ItemFilterRuntime } from 'src/runtime/item/ItemFilterRuntime.svelte';
import { Tidy5eActorSheetClassicV2Base } from './Tidy5eActorSheetClassicV2Base.svelte';
import type { ApplicationConfiguration } from 'src/types/application.types';
import { mapGetOrInsert } from 'src/utils/map';
import { buildRelativeUuid } from 'src/foundry/core-compat';

export class Tidy5eCharacterSheet
  extends Tidy5eActorSheetClassicV2Base<CharacterSheetContext>(
    CONSTANTS.SHEET_TYPE_CHARACTER
  )
  implements
    SheetTabCacheable,
    SheetExpandedItemsCacheable,
    SearchFilterCacheable
{
  aggregatePinTab = {
    tabId: CONSTANTS.TAB_CHARACTER_SHEET,
    tabName: 'TIDY5E.SheetTabName',
  };

  stats = $state<SheetStats>({
    lastSubmissionTime: null,
  });
  currentTabId: string;
  searchFilters: LocationToSearchTextMap = new Map<string, string>();
  expandedItems: ExpandedItemIdToLocationsMap = new Map<string, Set<string>>();
  expandedItemData: ExpandedItemData = new Map<string, ItemChatData>();
  inlineToggleService = new InlineToggleService();
  itemTableTogglesCache: ItemTableToggleCacheService;
  sectionExpansionTracker: ExpansionTracker;
  classSpellbookFilter: string = '';

  /**
   * The cached concentration information for the character.
   * @type {{items: Set<Item5e>, effects: Set<ActiveEffect5e>}}
   * @internal
   */
  _concentration: { items: Set<Item5e>; effects: Set<ActiveEffect5e> } = {
    items: new Set(),
    effects: new Set(),
  };

  constructor(...args: any[]) {
    super(...args);

    this.itemTableTogglesCache = new ItemTableToggleCacheService({
      userId: game.user.id,
      documentId: this.actor.id,
    });

    this.currentTabId = settings.value.initialCharacterSheetTab;

    this.sectionExpansionTracker = new ExpansionTracker(
      true,
      this.document,
      CONSTANTS.LOCATION_SECTION
    );
  }

  static DEFAULT_OPTIONS: Partial<ApplicationConfiguration> = {
    position: {
      width: 740,
      height: 810,
    },
  };

  _createComponent(node: HTMLElement): Record<string, any> {
    const component = mount(CharacterSheet, {
      target: node,
      context: new Map<any, any>([
        [CONSTANTS.SVELTE_CONTEXT.APP_ID, this.appId],
        [CONSTANTS.SVELTE_CONTEXT.CONTEXT, this._context],
        [CONSTANTS.SVELTE_CONTEXT.STATS, this.stats],
        [
          CONSTANTS.SVELTE_CONTEXT.ON_TAB_SELECTED,
          this.onTabSelected.bind(this),
        ],
        [CONSTANTS.SVELTE_CONTEXT.SEARCH_FILTERS, new Map(this.searchFilters)],
        [
          CONSTANTS.SVELTE_CONTEXT.INLINE_TOGGLE_SERVICE,
          this.inlineToggleService,
        ],
        [CONSTANTS.SVELTE_CONTEXT.ITEM_FILTER_SERVICE, this.itemFilterService],
        [
          CONSTANTS.SVELTE_CONTEXT.ON_FILTER,
          this.itemFilterService.onFilter.bind(this.itemFilterService),
        ],
        [
          CONSTANTS.SVELTE_CONTEXT.ON_FILTER_CLEAR_ALL,
          this.itemFilterService.onFilterClearAll.bind(this.itemFilterService),
        ],
        [CONSTANTS.SVELTE_CONTEXT.ON_SEARCH, this.onSearch.bind(this)],
        [
          CONSTANTS.SVELTE_CONTEXT.ON_ITEM_TOGGLED,
          this.onItemToggled.bind(this),
        ],
        [
          CONSTANTS.SVELTE_CONTEXT.ITEM_TABLE_TOGGLES,
          new Map(this.itemTableTogglesCache.itemTableToggles),
        ],
        [
          CONSTANTS.SVELTE_CONTEXT.ON_ITEM_TABLE_TOGGLE,
          this.itemTableTogglesCache.onItemTableToggle.bind(
            this.itemTableTogglesCache
          ),
        ],
        [CONSTANTS.SVELTE_CONTEXT.LOCATION, ''],
        [CONSTANTS.SVELTE_CONTEXT.EXPANDED_ITEMS, new Map(this.expandedItems)],
        [
          CONSTANTS.SVELTE_CONTEXT.EXPANDED_ITEM_DATA,
          new Map(this.expandedItemData),
        ],
        [
          CONSTANTS.SVELTE_CONTEXT.SECTION_EXPANSION_TRACKER,
          this.sectionExpansionTracker,
        ],
      ]),
    });

    initTidy5eContextMenu(this, node, CONSTANTS.SHEET_LAYOUT_CLASSIC);

    return component;
  }

  async _prepareContext(options = {}): Promise<CharacterSheetContext> {
    this._concentration = this.actor.concentration;

    const defaultDocumentContext = await super._prepareContext(options);

    const characterPreferences = UserSheetPreferencesService.getByType(
      this.actor.type
    );

    const attributesSortMode =
      characterPreferences.tabs?.[CONSTANTS.TAB_CHARACTER_ATTRIBUTES]?.sort ??
      'm';
    const inventorySortMode =
      characterPreferences.tabs?.[CONSTANTS.TAB_ACTOR_INVENTORY]?.sort ?? 'm';
    const spellbookSortMode =
      characterPreferences.tabs?.[CONSTANTS.TAB_ACTOR_SPELLBOOK]?.sort ?? 'm';
    const featureSortMode =
      characterPreferences.tabs?.[CONSTANTS.TAB_CHARACTER_FEATURES]?.sort ??
      'm';
    const actionListSortMode =
      characterPreferences.tabs?.[CONSTANTS.TAB_ACTOR_ACTIONS]?.sort ?? 'm';

    // TODO: Make a builder for this
    // TODO: Extract to runtime?
    let utilities: Utilities<CharacterSheetContext> = {
      [CONSTANTS.TAB_CHARACTER_ATTRIBUTES]: {
        utilityToolbarCommands: [
          {
            id: 'sort-mode-alpha',
            title: FoundryAdapter.localize('SIDEBAR.SortModeAlpha'),
            iconClass: 'fa-solid fa-arrow-down-a-z fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
                'sort',
                'm'
              );
            },
            visible: attributesSortMode === 'a',
          },
          {
            id: 'sort-mode-manual',
            title: FoundryAdapter.localize('SIDEBAR.SortModeManual'),
            iconClass: 'fa-solid fa-arrow-down-short-wide fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
                'sort',
                'a'
              );
            },
            visible: attributesSortMode === 'm',
          },
          {
            id: 'expand-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.ExpandAll'),
            iconClass: 'fas fa-angles-down',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
                true
              ),
          },
          {
            id: 'collapse-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.CollapseAll'),
            iconClass: 'fas fa-angles-up',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
                false
              ),
          },
          {
            id: 'configure-sections',
            title: FoundryAdapter.localize(
              'TIDY5E.Utilities.ConfigureSections'
            ),
            iconClass: 'fas fa-cog',
            execute: ({ context, sections }) => {
              new DocumentTabSectionConfigApplication(
                {
                  // Provide a way to build the necessary config, perhaps within the application constructor. We've got all the info we need in order to perform the operation.
                  sections: sections,
                  tabId: CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
                  tabTitle: CharacterSheetClassicRuntime.getTabTitle(
                    CONSTANTS.TAB_CHARACTER_ATTRIBUTES
                  ),
                },
                {
                  document: context.actor,
                }
              ).render(true);
            },
          },
        ],
      },
      [CONSTANTS.TAB_ACTOR_INVENTORY]: {
        utilityToolbarCommands: [
          {
            id: 'sort-mode-alpha',
            title: FoundryAdapter.localize('SIDEBAR.SortModeAlpha'),
            iconClass: 'fa-solid fa-arrow-down-a-z fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_ACTOR_INVENTORY,
                'sort',
                'm'
              );
            },
            visible: inventorySortMode === 'a',
          },
          {
            id: 'sort-mode-manual',
            title: FoundryAdapter.localize('SIDEBAR.SortModeManual'),
            iconClass: 'fa-solid fa-arrow-down-short-wide fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_ACTOR_INVENTORY,
                'sort',
                'a'
              );
            },
            visible: inventorySortMode === 'm',
          },
          {
            id: 'hide-container-panel',
            title: FoundryAdapter.localize(
              'TIDY5E.Commands.HideContainerPanel'
            ),
            iconClass: `fas fa-boxes-stacked fa-fw`,
            execute: () => {
              TidyFlags.showContainerPanel.unset(this.actor);
            },
            visible: !!TidyFlags.showContainerPanel.get(this.actor),
          },
          {
            id: 'show-container-panel',
            title: FoundryAdapter.localize(
              'TIDY5E.Commands.ShowContainerPanel'
            ),
            iconClass: `fas fa-box fa-fw`,
            execute: () => {
              TidyFlags.showContainerPanel.set(this.actor, true);
            },
            visible: !TidyFlags.showContainerPanel.get(this.actor),
          },
          {
            id: 'expand-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.ExpandAll'),
            iconClass: 'fas fa-angles-down',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_ACTOR_INVENTORY,
                true
              ),
          },
          {
            id: 'collapse-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.CollapseAll'),
            iconClass: 'fas fa-angles-up',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_ACTOR_INVENTORY,
                false
              ),
          },
          {
            id: 'list-layout',
            title: FoundryAdapter.localize('TIDY5E.ListLayout'),
            iconClass: 'fas fa-th-list fa-fw toggle-list',
            visible: !TidyFlags.inventoryGrid.get(this.actor),
            execute: () => {
              TidyFlags.inventoryGrid.set(this.actor);
            },
          },
          {
            id: 'grid-layout',
            title: FoundryAdapter.localize('TIDY5E.GridLayout'),
            iconClass: 'fas fa-th-large fa-fw toggle-grid',
            visible: !!TidyFlags.inventoryGrid.get(this.actor),
            execute: () => {
              TidyFlags.inventoryGrid.unset(this.actor);
            },
          },
          {
            id: 'configure-sections',
            title: FoundryAdapter.localize(
              'TIDY5E.Utilities.ConfigureSections'
            ),
            iconClass: 'fas fa-cog',
            execute: ({ context, sections }) => {
              new DocumentTabSectionConfigApplication(
                {
                  sections: sections,
                  tabId: CONSTANTS.TAB_ACTOR_INVENTORY,
                  tabTitle: CharacterSheetClassicRuntime.getTabTitle(
                    CONSTANTS.TAB_ACTOR_INVENTORY
                  ),
                },
                {
                  document: context.actor,
                }
              ).render(true);
            },
          },
        ],
      },
      [CONSTANTS.TAB_ACTOR_SPELLBOOK]: {
        utilityToolbarCommands: [
          {
            id: 'sort-mode-alpha',
            title: FoundryAdapter.localize('SIDEBAR.SortModeAlpha'),
            iconClass: 'fa-solid fa-arrow-down-a-z fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_ACTOR_SPELLBOOK,
                'sort',
                'm'
              );
            },
            visible: spellbookSortMode === 'a',
          },
          {
            id: 'sort-mode-manual',
            title: FoundryAdapter.localize('SIDEBAR.SortModeManual'),
            iconClass: 'fa-solid fa-arrow-down-short-wide fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_ACTOR_SPELLBOOK,
                'sort',
                'a'
              );
            },
            visible: spellbookSortMode === 'm',
          },
          {
            id: 'spell-pips',
            title: FoundryAdapter.localize('TIDY5E.Utilities.SpellPips'),
            iconClass: 'fa-regular fa-circle-dot fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypePreference(
                this.actor.type,
                CONSTANTS.SPELL_SLOT_TRACKER_MODE_PREFERENCE,
                CONSTANTS.SPELL_SLOT_TRACKER_MODE_VALUE_MAX
              );
            },
            visible:
              (characterPreferences?.spellSlotTrackerMode ??
                CONSTANTS.SPELL_SLOT_TRACKER_MODE_PIPS) ===
              CONSTANTS.SPELL_SLOT_TRACKER_MODE_PIPS,
          },
          {
            id: 'spell-value-max',
            title: FoundryAdapter.localize('TIDY5E.Utilities.SpellValueMax'),
            iconClass: 'fa-regular fa-square fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypePreference(
                this.actor.type,
                CONSTANTS.SPELL_SLOT_TRACKER_MODE_PREFERENCE,
                CONSTANTS.SPELL_SLOT_TRACKER_MODE_PIPS
              );
            },
            visible:
              characterPreferences?.spellSlotTrackerMode ===
              CONSTANTS.SPELL_SLOT_TRACKER_MODE_VALUE_MAX,
          },
          {
            id: 'expand-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.ExpandAll'),
            iconClass: 'fas fa-angles-down',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_ACTOR_SPELLBOOK,
                true
              ),
          },
          {
            id: 'collapse-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.CollapseAll'),
            iconClass: 'fas fa-angles-up',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_ACTOR_SPELLBOOK,
                false
              ),
          },
          {
            id: 'list-layout',
            title: FoundryAdapter.localize('TIDY5E.ListLayout'),
            iconClass: 'fas fa-th-list fa-fw toggle-list',
            visible: !TidyFlags.spellbookGrid.get(this.actor),
            execute: () => {
              TidyFlags.spellbookGrid.set(this.actor);
            },
          },
          {
            id: 'grid-layout',
            title: FoundryAdapter.localize('TIDY5E.GridLayout'),
            iconClass: 'fas fa-th-large fa-fw toggle-grid',
            visible: !!TidyFlags.spellbookGrid.get(this.actor),
            execute: () => {
              TidyFlags.spellbookGrid.unset(this.actor);
            },
          },
          {
            id: 'configure-sections',
            title: FoundryAdapter.localize(
              'TIDY5E.Utilities.ConfigureSections'
            ),
            iconClass: 'fas fa-cog',
            execute: ({ context, sections }) => {
              new DocumentTabSectionConfigApplication(
                {
                  sections: sections,
                  tabId: CONSTANTS.TAB_ACTOR_SPELLBOOK,
                  tabTitle: CharacterSheetClassicRuntime.getTabTitle(
                    CONSTANTS.TAB_ACTOR_SPELLBOOK
                  ),
                },
                {
                  document: context.actor,
                }
              ).render(true);
            },
          },
        ],
      },
      [CONSTANTS.TAB_CHARACTER_FEATURES]: {
        utilityToolbarCommands: [
          {
            id: 'sort-mode-alpha',
            title: FoundryAdapter.localize('SIDEBAR.SortModeAlpha'),
            iconClass: 'fa-solid fa-arrow-down-a-z fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_CHARACTER_FEATURES,
                'sort',
                'm'
              );
            },
            visible: featureSortMode === 'a',
          },
          {
            id: 'sort-mode-manual',
            title: FoundryAdapter.localize('SIDEBAR.SortModeManual'),
            iconClass: 'fa-solid fa-arrow-down-short-wide fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_CHARACTER_FEATURES,
                'sort',
                'a'
              );
            },
            visible: featureSortMode === 'm',
          },
          {
            id: 'expand-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.ExpandAll'),
            iconClass: 'fas fa-angles-down',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_CHARACTER_FEATURES,
                true
              ),
          },
          {
            id: 'collapse-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.CollapseAll'),
            iconClass: 'fas fa-angles-up',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_CHARACTER_FEATURES,
                false
              ),
          },
          {
            id: 'configure-sections',
            title: FoundryAdapter.localize(
              'TIDY5E.Utilities.ConfigureSections'
            ),
            iconClass: 'fas fa-cog',
            execute: ({ context, sections }) => {
              new DocumentTabSectionConfigApplication(
                {
                  sections: sections,
                  tabId: CONSTANTS.TAB_CHARACTER_FEATURES,
                  tabTitle: CharacterSheetClassicRuntime.getTabTitle(
                    CONSTANTS.TAB_CHARACTER_FEATURES
                  ),
                },
                {
                  document: context.actor,
                }
              ).render(true);
            },
          },
        ],
      },
      [CONSTANTS.TAB_ACTOR_ACTIONS]: {
        utilityToolbarCommands: [
          {
            id: 'sort-mode-alpha',
            title: FoundryAdapter.localize('SIDEBAR.SortModeAlpha'),
            iconClass: 'fa-solid fa-arrow-down-a-z fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_ACTOR_ACTIONS,
                'sort',
                'm'
              );
            },
            visible: actionListSortMode === 'a',
          },
          {
            id: 'action-list-default',
            title: FoundryAdapter.localize('TIDY5E.SortMode.ActionListDefault'),
            iconClass: 'fa-solid fa-arrow-down-short-wide fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_ACTOR_ACTIONS,
                'sort',
                'a'
              );
            },
            visible: actionListSortMode === 'm',
          },
          {
            id: 'expand-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.ExpandAll'),
            iconClass: 'fas fa-angles-down',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_ACTOR_ACTIONS,
                true
              ),
          },
          {
            id: 'collapse-all',
            title: FoundryAdapter.localize('TIDY5E.Commands.CollapseAll'),
            iconClass: 'fas fa-angles-up',
            execute: () =>
              this.sectionExpansionTracker.setAll(
                CONSTANTS.TAB_ACTOR_ACTIONS,
                false
              ),
          },
          {
            id: 'configure-sections',
            title: FoundryAdapter.localize(
              'TIDY5E.Utilities.ConfigureSections'
            ),
            iconClass: 'fas fa-cog',
            execute: ({ context, sections }) => {
              new DocumentTabSectionConfigApplication(
                {
                  sections: sections,
                  tabId: CONSTANTS.TAB_ACTOR_ACTIONS,
                  tabTitle: CharacterSheetClassicRuntime.getTabTitle(
                    CONSTANTS.TAB_ACTOR_ACTIONS
                  ),
                },
                {
                  document: context.actor,
                }
              ).render(true);
            },
          },
        ],
      },
    };

    // Effects & Conditions
    let { conditions, effects: enhancedEffectSections } =
      await ConditionsAndEffects.getConditionsAndEffectsForActor(
        this.actor,
        this.object,
        defaultDocumentContext.effects
      );

    for (const pinTabId of [
        CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
        CONSTANTS.TAB_ACTOR_INVENTORY,
        CONSTANTS.TAB_ACTOR_SPELLBOOK,
        CONSTANTS.TAB_CHARACTER_FEATURES,
        CONSTANTS.TAB_ACTOR_ACTIONS,
        CONSTANTS.TAB_CHARACTER_SHEET,
        CONSTANTS.TAB_EFFECTS,
      ]) {
      const utility = (utilities[pinTabId] ??= {
        utilityToolbarCommands: [],
      });
      (utility.utilityToolbarCommands ??= []).push(
        SheetPinsProvider.getToggleVisibilityUtilityCommand(
          this.actor.type,
          pinTabId
        )
      );
    }

    const autoIncludeUsableItems =
      TidyFlags.characterSheetTabAutomaticallyIncludeUsableItems.get(
        this.document
      ) ?? settings.value.characterSheetTabAutomaticallyIncludeUsableItems;

    const sheetTabUtility = (utilities[CONSTANTS.TAB_CHARACTER_SHEET] ??= {
      utilityToolbarCommands: [],
    });
    (sheetTabUtility.utilityToolbarCommands ??= []).push(
      {
        id: 'sheet-tab-organize-origin',
        title: FoundryAdapter.localize(
          'TIDY5E.Settings.CharacterSheetTabSectionOrganization.option.origin'
        ),
        iconClass: 'fa-solid fa-layer-group fa-fw',
        visible:
          this.getSheetTabSectionOrganization() !==
          CONSTANTS.SECTION_ORGANIZATION_ORIGIN,
        execute: async () => {
          await TidyFlags.characterSheetTabSectionOrganization.set(
            this.actor,
            CONSTANTS.SECTION_ORGANIZATION_ORIGIN
          );
        },
      },
      {
        id: 'sheet-tab-organize-action',
        title: FoundryAdapter.localize(
          'TIDY5E.Settings.CharacterSheetTabSectionOrganization.option.action'
        ),
        iconClass: 'fa-solid fa-bolt fa-fw',
        visible:
          this.getSheetTabSectionOrganization() !==
          CONSTANTS.SECTION_ORGANIZATION_ACTION,
        execute: async () => {
          await TidyFlags.characterSheetTabSectionOrganization.set(
            this.actor,
            CONSTANTS.SECTION_ORGANIZATION_ACTION
          );
        },
      },
      {
        id: 'sheet-tab-auto-include-on',
        title: FoundryAdapter.localize(
          'TIDY5E.Settings.CharacterSheetTabAutomaticallyIncludeUsableItems.name'
        ),
        iconClass: 'fa-solid fa-toggle-off fa-fw',
        visible: !autoIncludeUsableItems,
        execute: async () => {
          await TidyFlags.characterSheetTabAutomaticallyIncludeUsableItems.set(
            this.actor,
            true
          );
        },
      },
      {
        id: 'sheet-tab-auto-include-off',
        title: FoundryAdapter.localize(
          'TIDY5E.Settings.CharacterSheetTabAutomaticallyIncludeUsableItems.name'
        ),
        iconClass: 'fa-solid fa-toggle-on fa-fw',
        visible: autoIncludeUsableItems,
        execute: async () => {
          await TidyFlags.characterSheetTabAutomaticallyIncludeUsableItems.set(
            this.actor,
            false
          );
        },
      },
      {
        id: 'configure-sections',
        title: FoundryAdapter.localize('TIDY5E.Utilities.ConfigureSections'),
        iconClass: 'fas fa-cog',
        execute: ({ context, sections }) => {
          new DocumentTabSectionConfigApplication(
            {
              sections: sections,
              tabId: CONSTANTS.TAB_CHARACTER_SHEET,
              tabTitle: CharacterSheetClassicRuntime.getTabTitle(
                CONSTANTS.TAB_CHARACTER_SHEET
              ),
            },
            {
              document: context.actor,
            }
          ).render(true);
        },
      }
    );

    const context: CharacterSheetContext = {
      actorClassesToImages: getActorClassesToImages(this.actor),
      allowMaxHpOverride:
        settings.value.allowHpMaxOverride &&
        (!settings.value.lockHpMaxChanges || FoundryAdapter.userIsGm()),
      appearanceEnrichedHtml: await FoundryAdapter.enrichHtml(
        this.actor.system.details.appearance,
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      bastion: {
        description: await foundry.applications.ux.TextEditor.enrichHTML(
          this.actor.system.bastion.description,
          {
            secrets: this.actor.isOwner,
            rollData: defaultDocumentContext.rollData,
            relativeTo: this.actor,
          }
        ),
      },
      biographyEnrichedHtml: await FoundryAdapter.enrichHtml(
        this.actor.system.details.biography.value,
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      bondEnrichedHtml: await FoundryAdapter.enrichHtml(
        this.actor.system.details.bond,
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      conditions: conditions,
      containerPanelItems: await Inventory.getContainerPanelItems(
        defaultDocumentContext.items
      ),
      defenders: [],
      epicBoonsEarned: undefined,
      facilities: {
        basic: { chosen: [], available: [], value: 0, max: 0 },
        special: { chosen: [], available: [], value: 0, max: 0 },
      },
      favorites: [],
      features: [],
      flawEnrichedHtml: await FoundryAdapter.enrichHtml(
        this.actor.system.details.flaw,
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      idealEnrichedHtml: await FoundryAdapter.enrichHtml(
        this.actor.system.details.ideal,
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      inventory: [],
      languages: [],
      notes1EnrichedHtml: await FoundryAdapter.enrichHtml(
        TidyFlags.notes1.members.value.get(this.actor) ?? '',
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      notes2EnrichedHtml: await FoundryAdapter.enrichHtml(
        TidyFlags.notes2.members.value.get(this.actor) ?? '',
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      notes3EnrichedHtml: await FoundryAdapter.enrichHtml(
        TidyFlags.notes3.members.value.get(this.actor) ?? '',
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      notes4EnrichedHtml: await FoundryAdapter.enrichHtml(
        TidyFlags.notes4.members.value.get(this.actor) ?? '',
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      notesEnrichedHtml: await FoundryAdapter.enrichHtml(
        TidyFlags.notes.members.value.get(this.actor) ?? '',
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      showContainerPanel:
        TidyFlags.showContainerPanel.get(this.actor) === true &&
        Array.from(defaultDocumentContext.items).some(
          (i: Item5e) => i.type === CONSTANTS.ITEM_TYPE_CONTAINER
        ),
      spellbook: [],
      spellcastingInfo: FoundryAdapter.getSpellcastingInfo(this.actor),
      spellComponentLabels: FoundryAdapter.getSpellComponentLabels(),
      spellSlotTrackerMode:
        characterPreferences.spellSlotTrackerMode ??
        CONSTANTS.SPELL_SLOT_TRACKER_MODE_PIPS,
      traitEnrichedHtml: await FoundryAdapter.enrichHtml(
        this.actor.system.details.trait,
        {
          secrets: this.actor.isOwner,
          rollData: defaultDocumentContext.rollData,
          relativeTo: this.actor,
        }
      ),
      useActionsFeature: actorUsesActionFeature(this.actor),
      sheetTabSections: [],
      utilities: utilities,
      ...defaultDocumentContext,
    };

    context.filterData = this.itemFilterService.getFilterData();
    context.filterPins = ItemFilterRuntime.defaultFilterPins[this.actor.type];

    context.allowEffectsManagement =
      FoundryAdapter.allowCharacterEffectsManagement(this.actor);

    context.customActorTraits = CustomActorTraitsRuntime.getEnabledTraitsLegacy({
      context,
      app: this,
      element: this.element,
    });

    context.effects = enhancedEffectSections;

    context.useClassicControls = settings.value.useClassicControlsForCharacter;

    context.customContent = await CharacterSheetClassicRuntime.getContent(
      context
    );

    if (context.system.details.xp.boonsEarned !== undefined) {
      const pluralRules = new Intl.PluralRules(game.i18n.lang);

      context.epicBoonsEarned = FoundryAdapter.localize(
        `DND5E.ExperiencePoints.Boons.${pluralRules.select(
          this.actor.system.details.xp.boonsEarned ?? 0
        )}`,
        {
          number: dnd5e.utils.formatNumber(
            this.actor.system.details.xp.boonsEarned ?? 0,
            { signDisplay: 'always' }
          ),
        }
      );
    }

    for (const panelItem of context.containerPanelItems) {
      const ctx = context.itemContext[panelItem.container.id];
      ctx.containerContents = await Container.getContainerContents(
        panelItem.container,
        {
          hasActor: true,
          unlocked: context.unlocked,
        }
      );
    }

    await this._prepareFacilities(context);

    let tabs = await CharacterSheetClassicRuntime.getTabs(context);

    const selectedTabs = TidyFlags.selectedTabs.get(context.actor);

    if (selectedTabs?.length) {
      tabs = tabs
        .filter((t) => selectedTabs?.includes(t.id))
        .sort(
          (a, b) => selectedTabs.indexOf(a.id) - selectedTabs.indexOf(b.id)
        );
    } else {
      const defaultTabs = settings.value.defaultCharacterSheetTabs;
      tabs = tabs
        .filter((t) => defaultTabs?.includes(t.id))
        .sort((a, b) => defaultTabs.indexOf(a.id) - defaultTabs.indexOf(b.id));
    }

    context.tabs = tabs;

    TidyHooks.tidy5eSheetsPreConfigureSections(this, this.element, context);

    // Apply Section Configs
    // ------------------------------------------------------------

    let effectsSection: EffectFavoriteSection = {
      type: CONSTANTS.SECTION_TYPE_EFFECT,
      canCreate: false,
      dataset: {},
      effects: [],
      key: 'tidy-favorite-effects',
      label: 'DND5E.Effects',
      show: true,
      rowActions: [], // for the UI Overhaul
      sectionActions: [], // for the UI Overhaul
    };
    const favoriteEffects = (
      this.actor.system.favorites as CharacterFavorite[]
    ).filter((f) => f.type === CONSTANTS.SECTION_TYPE_EFFECT);

    // TODO: Do I need to remove active effects from favorites when they are no longer available on the sheet?
    // Or does the system do this?
    for (const favoriteEffect of favoriteEffects) {
      const effect = await fromUuid(favoriteEffect.id, {
        relative: this.actor,
      });

      if (!effect) {
        continue;
      }

      const data = await effect.getFavoriteData();

      if (data.suppressed) {
        data.subtitle = game.i18n.localize('DND5E.Suppressed');
      }

      effectsSection.effects.push({
        effectId: effect.id,
        effect: effect,
        id: favoriteEffect.id,
        img: data.img,
        sort: favoriteEffect.sort,
        subtitle: data.subtitle,
        suppressed: data.suppressed,
        title: data.title,
        toggle: { applicable: true, value: data.toggle },
      });
    }

    const activitiesSection: ActivitySection = {
      activities: [],
      dataset: {},
      key: 'tidy-favorite-activities',
      label: 'DND5E.ACTIVITY.Title.other',
      show: true,
      type: CONSTANTS.SECTION_TYPE_ACTIVITY,
      rowActions: [], // for the UI Overhaul
      sectionActions: [], // for the UI Overhaul
    };

    const favoriteActivities = (
      this.actor.system.favorites as CharacterFavorite[]
    ).filter((f) => f.type === 'activity');

    for (const favoriteActivity of favoriteActivities) {
      const activity = await fromUuid(favoriteActivity.id, {
        relative: this.actor,
      });

      if (!activity) {
        continue;
      }

      activitiesSection.activities.push(activity);
    }

    // Favorites
    context.favorites = CharacterSheetSections.mergeDuplicateFavoriteSections(
      context.favorites
    );

    if (effectsSection.effects.length) {
      context.favorites.push({
        ...effectsSection,
        type: CONSTANTS.SECTION_TYPE_EFFECT,
      });
    }

    if (activitiesSection.activities.length) {
      context.favorites.push(activitiesSection);
    }

    await this.setExpandedItemData();
    SheetSections.accountForExternalSections(
      ['actions', 'favorites', 'inventory', 'spellbook', 'features'],
      context
    );

    await this.prepareSheetTabSections(context);

    debug('Character Sheet context data', context);

    return context;
  }

  async prepareSheetTabSections(context: CharacterSheetContext) {
    const organization = this.getSheetTabSectionOrganization();

    if (organization === CONSTANTS.SECTION_ORGANIZATION_ACTION) {
      context.sheetTabSections = await getCharacterSheetTabActionSections(
        this.actor,
        context
      );
    } else {
      this.setUpSheetTabOriginSections(context);
    }
  }

  getSheetTabSectionOrganization(): 'action' | 'origin' {
    return (
      TidyFlags.characterSheetTabSectionOrganization.get(this.document) ??
      settings.value.characterSheetTabOrganization
    );
  }

  getSheetTabInclusionMode() {
    const enableAutoInclusion =
      TidyFlags.characterSheetTabAutomaticallyIncludeUsableItems.get(
        this.document
      ) ?? settings.value.characterSheetTabAutomaticallyIncludeUsableItems;

    return enableAutoInclusion ? 'usable-and-flag' : 'flag-only';
  }

  shouldIncludeItemInSheetTab(
    item: Item5e,
    inclusionMode: ActionItemInclusionMode,
    sheetTabOrganization:
      | typeof CONSTANTS.SECTION_ORGANIZATION_ACTION
      | typeof CONSTANTS.SECTION_ORGANIZATION_ORIGIN
  ) {
    if (item.actor?.type !== CONSTANTS.SHEET_TYPE_CHARACTER) {
      return false;
    }

    const includeOverride = TidyFlags.sheetTabItemInclude.get(item);

    if (includeOverride === false) {
      return false;
    }

    if (includeOverride === true) {
      return true;
    }

    const contained = item.actor.items.has(item.system.container);

    return sheetTabOrganization === 'origin'
      ? !contained && isItemInActionList(item, inclusionMode)
      : isItemInActionList(item, inclusionMode);
  }

  private setUpSheetTabOriginSections(context: CharacterSheetContext) {
    const inventoryTypes = Inventory.getInventoryTypes();
    const inventory: ActorInventoryTypes =
      Inventory.getDefaultInventorySections({
        canCreate: true,
      });

    const partitions = (this.actor.items as any[])
      .filter(
        (item) =>
          context.itemContext[item.id]?.includeInCharacterSheetTab === true
      )
      .reduce(
        (partitions, item) => {
          CharacterSheetSections.partitionItem(item, partitions, inventory);

          return partitions;
        },
        {
          items: [] as Item5e[],
          spells: [] as Item5e[],
          facilities: [] as Item5e[],
          feats: [] as Item5e[],
          species: [] as Item5e[],
          backgrounds: [] as Item5e[],
          classes: [] as Item5e[],
          subclasses: [] as Item5e[],
        }
      );

    for (let item of partitions.items) {
      Inventory.applyInventoryItemToSection(
        inventory,
        item,
        inventoryTypes,
        {
          canCreate: true,
        },
        '',
        'actionSection'
      );
    }

    const spellbook = SheetSections.prepareTidySpellbook(
      context,
      CONSTANTS.TAB_CHARACTER_SHEET,
      partitions.spells,
      {
        canCreate: true,
      },
      'actionSection'
    );

    const features: Record<string, CharacterFeatureSection> =
      CharacterSheetSections.buildClassicFeaturesSections(
        this.actor,
        CONSTANTS.TAB_CHARACTER_SHEET,
        partitions.species,
        partitions.backgrounds,
        partitions.classes,
        [...partitions.feats, ...partitions.subclasses],
        {
          canCreate: true,
        },
        'actionSection'
      );

    context.sheetTabSections = [
      ...Object.values(inventory),
      ...spellbook,
      ...Object.values(features),
    ].filter((s) => s.items?.length);
  }

  _prepareItems(context: CharacterSheetContext) {
    // Categorize items as inventory, spellbook, features, and classes
    const inventory: ActorInventoryTypes =
      Inventory.getDefaultInventorySections();
    const favoriteInventory: ActorInventoryTypes =
      Inventory.getDefaultInventorySections({
        canCreate: false,
      });

    const favoritesIdMap: Map<string, CharacterFavorite> =
      this._getFavoritesIdMap();

    const inclusionMode = this.getSheetTabInclusionMode();
    const sheetTabOrganization = this.getSheetTabSectionOrganization();

    // Partition items by category
    let {
      backgrounds,
      classes,
      favorites,
      feats,
      items,
      species,
      spells,
      subclasses,
    } = Array.from<Item5e>(this.actor.items).reduce(
      (
        obj: CharacterItemPartitions & { favorites: CharacterItemPartitions },
        item: Item5e
      ) => {
        const { quantity } = item.system;

        // Item details
        const ctx = (context.itemContext[item.id] ??= {});
        ctx.isStack = Number.isNumeric(quantity) && quantity !== 1;
        ctx.attunement = FoundryAdapter.getAttunementContext(item);

        // Item usage
        ctx.hasUses = item.hasLimitedUses;
        ctx.hasRecharge = item.hasRecharge;

        ctx.includeInCharacterSheetTab = this.shouldIncludeItemInSheetTab(
          item,
          inclusionMode,
          sheetTabOrganization
        );

        // Unidentified items
        ctx.concealDetails =
          !game.user.isGM && item.system.identified === false;

        // Item grouping
        const [originId] =
          item
            .getFlag('dnd5e', CONSTANTS.SYSTEM_FLAG_ADVANCEMENT_ORIGIN)
            ?.split('.') ?? [];
        const group = this.actor.items.get(originId);
        switch (group?.type) {
          case 'race':
            ctx.group = 'species';
            break;
          case 'background':
            ctx.group = 'background';
            break;
          case 'class':
            ctx.group = group.identifier;
            break;
          case 'subclass':
            ctx.group = group.class?.identifier ?? 'other';
            break;
          default:
            ctx.group = 'other';
        }

        // Individual item preparation
        this._prepareItem(item, ctx);

        const isWithinContainer = this.actor.items.has(item.system.container);

        // Classify items into types
        if (!isWithinContainer) {
          CharacterSheetSections.partitionItem(item, obj, inventory);
        }

        const favoritedItem = favoritesIdMap.get(
          buildRelativeUuid(item, this.actor)
        );
        if (favoritedItem?.type === 'item') {
          ctx.favoriteId = favoritedItem.id;
          CharacterSheetSections.partitionItem(
            item,
            obj.favorites,
            favoriteInventory
          );
        }

        return obj;
      },
      {
        items: [] as Item5e[],
        spells: [] as Item5e[],
        facilities: [] as Item5e[],
        feats: [] as Item5e[],
        species: [] as Item5e[],
        backgrounds: [] as Item5e[],
        classes: [] as Item5e[],
        subclasses: [] as Item5e[],
        favorites: {
          items: [] as Item5e[],
          spells: [] as Item5e[],
          facilities: [] as Item5e[],
          feats: [] as Item5e[],
          species: [] as Item5e[],
          backgrounds: [] as Item5e[],
          classes: [] as Item5e[],
          subclasses: [] as Item5e[],
        },
      }
    );

    const inventoryTypes = Inventory.getInventoryTypes();
    // Organize items
    // Section the items by type
    for (const item of items) {
      const ctx = (context.itemContext[item.id] ??= {});
      ctx.totalWeight = item.system.totalWeight?.toNearest(0.1);
      Inventory.applyInventoryItemToSection(inventory, item, inventoryTypes, {
        canCreate: true,
      });
    }

    SheetSections.getFilteredGlobalSectionsToShowWhenEmpty(
      context.actor,
      CONSTANTS.TAB_ACTOR_INVENTORY
    ).forEach((s) => {
      inventory[s] ??= Inventory.createInventorySection(s, inventoryTypes, {
        canCreate: true,
      });
    });

    // Section favorite items by type
    for (const item of favorites.items) {
      const ctx = (context.itemContext[item.id] ??= {});
      ctx.totalWeight = item.system.totalWeight?.toNearest(0.1);
      Inventory.applyInventoryItemToSection(
        favoriteInventory,
        item,
        inventoryTypes,
        {
          canCreate: false,
        }
      );
    }

    // Section spells
    // TODO: Take over `_prepareSpellbook` and
    // - have custom sectioning built right into the process
    // - set up `key` in the spellbook prep code, just like `prop`
    const spellbook = SheetSections.prepareTidySpellbook(
      context,
      CONSTANTS.TAB_ACTOR_SPELLBOOK,
      spells,
      {
        canCreate: true,
      }
    );

    // Section Favorite Spells
    const favoriteSpellbook = SheetSections.prepareTidySpellbook(
      context,
      CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
      favorites.spells,
      {
        canCreate: false,
      }
    );

    // Process Special Feature Item Context
    classes = SheetSections.prepareClassItems(
      context,
      classes,
      subclasses,
      this.actor
    );

    // Put unmatched subclasses into features so they don't disappear
    for (const subclass of subclasses) {
      feats.push(subclass);
      const message = game.i18n.format('DND5E.SubclassMismatchWarn', {
        name: subclass.name,
        class: subclass.system.classIdentifier,
      });
      context.warnings.push({ message, type: 'warning' });
    }

    // Process Special Favorite Feature Item Context
    favorites.classes = SheetSections.prepareClassItems(
      context,
      favorites.classes,
      favorites.subclasses,
      this.actor
    );

    for (const subclass of favorites.subclasses) {
      favorites.feats.push(subclass);
    }

    // Section Features
    const features: Record<string, CharacterFeatureSection> =
      CharacterSheetSections.buildClassicFeaturesSections(
        this.actor,
        CONSTANTS.TAB_CHARACTER_FEATURES,
        species,
        backgrounds,
        classes,
        feats,
        {
          canCreate: true,
        }
      );

    // Section favorite features
    const favoriteFeatures: Record<string, CharacterFeatureSection> =
      CharacterSheetSections.buildClassicFeaturesSections(
        this.actor,
        CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
        favorites.species,
        favorites.backgrounds,
        favorites.classes,
        favorites.feats,
        { canCreate: false }
      );

    // Facility Favorites
    let bastionFacilitiesLabel = !isNil(context.system.bastion.name, '')
      ? context.system.bastion.name
      : 'TYPES.Item.facilityPl';

    let favoriteFacilities: FacilitySection[] = [
      {
        type: CONSTANTS.SECTION_TYPE_FACILITY,
        dataset: {},
        items: favorites.facilities,
        key: 'tidy-favorite-bastion-facilities',
        label: bastionFacilitiesLabel,
        show: true,
        rowActions: [], // for the UI Overhaul
        sectionActions: [], // for the UI Overhaul
      },
    ];

    // Apply sections to their section lists

    context.inventory = Object.values(inventory);

    context.spellbook = spellbook;

    context.features = Object.values(features);

    context.favorites = [
      ...Object.values(favoriteInventory)
        .filter((i) => i.items.length)
        .map((i) => ({
          ...i,
          type: CONSTANTS.SECTION_TYPE_INVENTORY,
        })),
      ...Object.values(favoriteFeatures)
        .filter((i) => i.items.length)
        .map((i) => ({
          ...i,
          type: CONSTANTS.SECTION_TYPE_FEATURE,
        })),
      ...favoriteSpellbook
        .filter((s: SpellbookSection) => s.items.length)
        .map((s: SpellbookSection) => ({
          ...s,
          type: CONSTANTS.SECTION_TYPE_SPELLBOOK,
        })),
      ...favoriteFacilities
        .filter((i) => i.items.length)
        .map((i) => ({
          ...i,
          type: CONSTANTS.SECTION_TYPE_FACILITY,
        })),
    ];
  }

  /**
   * Prepare bastion facility data for display.
   */
  async _prepareFacilities(context: CharacterSheetContext): Promise<void> {
    const prepared = await Bastion.prepareFacilities(this.actor);

    for (const [facilityId, chosen] of prepared.byId) {
      const itemContext = (context.itemContext[facilityId] ??= {});
      itemContext.chosen = chosen;
    }

    context.defenders = prepared.defenders;
    context.facilities = prepared.facilities;
  }

  private _getFavoritesIdMap(): Map<string, CharacterFavorite> {
    return this.actor.system.favorites.reduce(
      (map: Map<string, CharacterFavorite>, f: CharacterFavorite) => {
        map.set(f.id, f);
        return map;
      },
      new Map<string, CharacterFavorite>()
    );
  }

  /**
   * A helper method to establish the displayed preparation state for an item.
   * @param {Item5e} item     Item being prepared for display.
   * @param {object} context  Context data for display.
   * @protected
   */
  protected _prepareItem(item: Item5e, context: CharacterItemContext) {
    if (item.type === CONSTANTS.ITEM_TYPE_SPELL) {
      if (this._concentration.items.has(item)) {
        context.concentration = true;
      }
    }

    // Save
    context.save = ItemContext.getItemSaveContext(item);

    // To Hit
    context.toHit = ItemContext.getToHit(item);

    // Activities
    context.activities = Activities.getVisibleActivities(
      item,
      item.system.activities
    )?.map(Activities.getActivityItemContext);

    context.linkedUses = Activities.getLinkedUses(item);
  }

  private async setExpandedItemData() {
    this.expandedItemData.clear();
    for (const [id, locations] of this.expandedItems) {
      if (locations.size === 0) {
        continue;
      }
      const item = this.actor.items.get(id);
      if (item) {
        this.expandedItemData.set(
          id,
          await item.getChatData({ secrets: this.actor.isOwner })
        );
      }
    }
  }

  async _onDropSingleItem(
    itemData: any,
    event: DragEvent & { target: HTMLElement; currentTarget: HTMLElement }
  ) {
    // Create a Consumable spell scroll on the Inventory tab
    if (
      itemData.type === CONSTANTS.ITEM_TYPE_SPELL &&
      this.currentTabId === CONSTANTS.TAB_ACTOR_INVENTORY
    ) {
      const options: Record<string, unknown> = {};

      if (settings.value.includeFlagsInSpellScrollCreation) {
        options.flags = itemData.flags;
      }

      const scroll = await dnd5e.documents.Item5e.createScrollFromSpell(
        itemData,
        options
      );

      return scroll.toObject();
    }

    return await super._onDropSingleItem(itemData, event);
  }

  deleteOccupant(facilityId: string, prop: string, index: number) {
    const facility = this.actor.items.get(facilityId);

    if (!facility || !prop || index === undefined) {
      return;
    }

    return Bastion.deleteOccupant(facility, prop, index);
  }

  _disableFields(...args: any[]) {
    debug('Ignoring call to disable fields. Delegating to Tidy Sheets...');
  }

  async _onDrop(
    event: DragEvent & { currentTarget: HTMLElement; target: HTMLElement }
  ) {
    if (
      !event.target.closest(
        '[data-tidy-favorites], [data-tidy-sheet-part="sheet-pins"]'
      )
    ) {
      return await super._onDrop(event);
    }

    const dragData = event.dataTransfer?.getData('text/plain');

    if (!dragData) {
      return await super._onDrop(event);
    }

    let data;
    try {
      data = JSON.parse(dragData);
    } catch (e) {
      console.error(e);
      return;
    }

    if (data.type === CONSTANTS.DOCUMENT_NAME_ACTOR) {
      return await super._onDrop(event);
    }

    const doc = await fromUuid(data.uuid);
    let relativeUuid = SheetPinsProvider.getRelativeUUID(doc);

    if (event.target.closest('[data-tidy-sheet-part="sheet-pins"]')) {
      return await this._onDropSheetPin(event, { id: relativeUuid, doc });
    }

    let type = 'item' as const;

    return await this._onDropFavorite(event, { type, id: relativeUuid });
  }

  _prepareTraits(systemData: any) {
    const traits = super._prepareTraits(systemData);

    const selectedWeaponProfs = traits.traits?.weaponProf?.selected;
    for (const key of systemData.traits?.weaponProf?.mastery?.value ?? []) {
      if (!Object.hasOwn(selectedWeaponProfs, key)) {
        selectedWeaponProfs[key] =
          dnd5e.documents.Trait.keyLabel(key, { trait: 'weapon' }) ?? key;
      }
    }

    FoundryAdapter.prepareLanguageTrait(this.actor, traits);

    return traits;
  }

  /** @inheritDoc */
  async _onDropActor(
    event: DragEvent & { currentTarget: HTMLElement; target: HTMLElement },
    data: any
  ) {
    if (!event.target.closest('.facility-occupants') || !data.uuid) {
      return await super._onDropActor(event, data);
    }

    const facilityId =
      event.target.closest<HTMLElement>('[data-facility-id]')?.dataset?.[
        'facilityId'
      ];

    const facility = this.actor.items.get(facilityId);

    if (!facility) {
      return;
    }

    const propDataset =
      event.target.closest<HTMLElement>('[data-prop]')?.dataset;

    const prop = propDataset?.['prop'];

    if (!prop) {
      return;
    }

    this._onDropActorAddToFacility(facility, prop, data.uuid);
  }

  _onDropActorAddToFacility(facility: Item5e, prop: string, actorUuid: string) {
    return Bastion.addFacilityOccupant(facility, prop, actorUuid);
  }

  /* -------------------------------------------- */
  /* -------------------------------------------- */
  /* Favorites
  /* -------------------------------------------- */

  /**
   * Handle an owned item or effect being dropped in the favorites area.
   * @param {PointerEvent} event         The triggering event.
   * @param {ActorFavorites5e} favorite  The favorite that was dropped.
   * @returns {Promise<Actor5e>|void}
   * @protected
   */
  async _onDropFavorite(
    event: DragEvent & { currentTarget: HTMLElement; target: HTMLElement },
    favorite: UnsortedCharacterFavorite
  ) {
    if (this.actor.system.hasFavorite(favorite.id))
      return await this._onSortFavorites(event, favorite.id);
    // If we don't own the item, handle onDrop and then turn around and add it as a favorite?
    return await this.actor.system.addFavorite(favorite);
  }

  /**
   * Handle re-ordering the favorites list.
   * @param {DragEvent} event  The drop event.
   * @param {string} srcId     The identifier of the dropped favorite.
   * @returns {Promise<Actor5e>|void}
   * @protected
   */
  async _onSortFavorites(
    event: DragEvent & { currentTarget: HTMLElement; target: HTMLElement },
    srcId: string
  ) {
    const targetId = event.target
      ?.closest('[data-favorite-id]')
      ?.getAttribute('data-favorite-id');

    if (!targetId) return;

    if (srcId === targetId) return;

    let source;
    let target;
    const siblings = this.actor.system.favorites.filter(
      (f: CharacterFavorite) => {
        if (f.id === targetId) target = f;
        else if (f.id === srcId) source = f;
        return f.id !== srcId;
      }
    );
    const updates = foundry.utils.performIntegerSort(source, {
      target,
      siblings,
    });
    const favorites = this.actor.system.favorites.reduce(
      (map: Map<string, CharacterFavorite>, f: CharacterFavorite) =>
        map.set(f.id, { ...f }),
      new Map<string, CharacterFavorite>()
    );
    for (const { target, update } of updates) {
      const favorite = favorites.get(target.id);
      foundry.utils.mergeObject(favorite, update);
    }
    return await this.actor.update({
      'system.favorites': Array.from(favorites.values()),
    });
  }

  /* -------------------------------------------- */
  /* SheetTabCacheable
  /* -------------------------------------------- */

  onTabSelected(tabId: string) {
    this.currentTabId = tabId;
  }

  /* -------------------------------------------- */
  /* SheetExpandedItemsCacheable
  /* -------------------------------------------- */

  onItemToggled(itemId: string, isVisible: boolean, location: string) {
    const locationSet = mapGetOrInsert(
      this.expandedItems,
      itemId,
      new Set<string>()
    );

    if (isVisible) {
      locationSet?.add(location);
    } else {
      locationSet?.delete(location);
    }
  }

  /* -------------------------------------------- */
  /* SearchFilterCacheable
  /* -------------------------------------------- */

  onSearch(location: string, text: string): void {
    debug('Searched', {
      location,
      text,
    });
    this.searchFilters.set(location, text);
  }

  /* -------------------------------------------- */
  /* Class Spellbook Filter
  /* -------------------------------------------- */

  setClassSpellbookFilter(value: string) {
    this.classSpellbookFilter = value;
    this.render();
  }
}

function getActorClassesToImages(actor: Actor5e): Record<string, string> {
  let actorClassesToImages: Record<string, string> = {};
  for (const item of actor.items) {
    if (item.type == CONSTANTS.ITEM_TYPE_CLASS) {
      let className = item.name.toLowerCase();
      let classImg = item.img;
      actorClassesToImages[className] = classImg;
    }
  }
  return actorClassesToImages;
}
