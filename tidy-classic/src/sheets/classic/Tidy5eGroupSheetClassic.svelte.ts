import { CONSTANTS } from 'src/constants';
import { SheetPinsProvider } from 'src/features/sheet-pins/SheetPinsProvider';
import {
  type ApplicationClosingOptions,
  type ApplicationConfiguration,
  type ApplicationRenderOptions,
} from 'src/types/application.types';
import { mount } from 'svelte';
import GroupSheet from './group/GroupSheet.svelte';
import type {
  Actor5e,
  ActorInventoryTypes,
  DocumentSheetV2Context,
  FacilityOccupantSlot,
  Utilities,
} from 'src/types/types';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import type {
  Group5e,
  Group5eMember,
  Group5eXp,
  GroupAbility,
  GroupBastionsContext,
  GroupItemContext,
  GroupLanguage,
  GroupMemberAbilityContext,
  GroupMemberBastionContext,
  GroupMemberContext,
  GroupMemberSection,
  GroupMemberSkillInfo,
  GroupSheetClassicContext,
  GroupSkill,
} from 'src/types/group.types';
import { Inventory } from 'src/features/sections/Inventory';
import { settings, systemSettings } from 'src/settings/settings.svelte';
import { ActorPortraitRuntime } from 'src/runtime/ActorPortraitRuntime';
import { getPercentage } from 'src/utils/numbers';
import type { Item5e } from 'src/types/item.types';
import { Tidy5eActorSheetBaseMixin } from 'src/mixins/Tidy5eActorSheetBaseMixin';
import { UserSheetPreferencesService } from 'src/features/user-preferences/SheetPreferencesService';
import { TidyFlags } from 'src/foundry/TidyFlags';
import { Container } from 'src/features/containers/Container';
import { ItemFilterRuntime } from 'src/runtime/item/ItemFilterRuntime.svelte';
import { ItemFilterService } from 'src/features/filtering/ItemFilterService.svelte';
import { DocumentTabSectionConfigApplication } from 'src/applications/section-config/DocumentTabSectionConfigApplication.svelte';
import { InlineToggleService } from 'src/features/expand-collapse/InlineToggleService.svelte';
import { initTidy5eContextMenu } from 'src/context-menu/tidy5e-context-menu';
import { debug, warn } from 'src/utils/logging';
import { processInputChangeDeltaFromValues } from 'src/utils/form';
import { isNil } from 'src/utils/data';
import { formatAsModifier, getModifierData } from 'src/utils/formatting';
import { TidyHooks } from 'src/foundry/TidyHooks';
import { SvelteApplicationMixin } from 'src/mixins/SvelteApplicationMixin.svelte';
import { Activities } from 'src/features/activities/activities';
import AttachedInfoCard from 'src/components/info-card/AttachedInfoCard.svelte';
import { ImportSheetControl } from '../../features/sheet-header-controls/ImportSheetControl';
import { SheetSections } from 'src/features/sections/SheetSections';
import { ExpansionTracker } from 'src/features/expand-collapse/ExpansionTracker.svelte';
import { ItemContext } from 'src/features/item/ItemContext';
import {
  TidyExtensibleDocumentSheetMixin,
  type TidyDocumentSheetRenderOptions,
} from 'src/mixins/TidyDocumentSheetMixin.svelte';
import GroupSheetClassicRuntime from 'src/runtime/actor/GroupSheetClassicRuntime.svelte';
import SheetHeaderModeToggleV2 from './shared/SheetHeaderModeToggleV2.svelte';
import {
  getSenseLabel,
  getSenseRange,
  refreshActor,
} from 'src/foundry/dnd5e-compat';
import * as Bastion from 'src/features/facility/Bastion';
import { BastionMaintainOrderDialog } from 'src/features/facility/BastionMaintainOrderDialog';
import {
  FacilityOccupantSlotPropsMap,
  FacilityOccupantSlotTypesMap,
} from 'src/features/facility/facility';

type MemberStats = {
  currentHP: number;
  maxHP: number;
  memberCount: number;
  vehicleCount: number;
};

export class Tidy5eGroupSheetClassic extends Tidy5eActorSheetBaseMixin(
  TidyExtensibleDocumentSheetMixin(
    CONSTANTS.SHEET_TYPE_GROUP,
    SvelteApplicationMixin<
      ApplicationConfiguration | undefined,
      GroupSheetClassicContext
    >(foundry.applications.sheets.ActorSheetV2)
  )
) {
  aggregatePinTab = {
    tabId: CONSTANTS.TAB_MEMBERS,
    tabName: 'DND5E.Group.Member.other',
  };

  sectionExpansionTracker: ExpansionTracker;

  constructor(options?: Partial<ApplicationConfiguration> | undefined) {
    super(options);

    this._supportedItemTypes = new Set(Inventory.getInventoryTypes());
    this._supportedItemTypes.add(CONSTANTS.ITEM_TYPE_SPELL);
    this.itemFilterService = new ItemFilterService({}, this.actor);

    this.sectionExpansionTracker = new ExpansionTracker(
      true,
      this.document,
      CONSTANTS.LOCATION_SECTION
    );
  }

  static DEFAULT_OPTIONS: Partial<
    ApplicationConfiguration & { dragDrop: Partial<DragDropConfiguration>[] }
  > = {
    classes: [
      CONSTANTS.MODULE_ID,
      'sheet',
      'actor',
      CONSTANTS.SHEET_TYPE_GROUP,
      CONSTANTS.SHEET_LAYOUT_CLASSIC,
    ],
    tag: 'form',
    window: {
      frame: true,
      positioned: true,
      resizable: true,
      controls: [
        this.ACTOR_ACTIONS_AND_CONTROLS.showPortraitArtwork.control,
        this.ACTOR_ACTIONS_AND_CONTROLS.showTokenArtwork.control,
        this.ACTOR_ACTIONS_AND_CONTROLS.openTabSelection.control,
      ],
    },
    position: {
      width: 600,
      height: 700,
    },
    dragDrop: [
      {
        dragSelector: `[data-tidy-always-draggable]`,
        dropSelector: null,
      },
      {
        dragSelector: '[data-tidy-draggable]',
        dropSelector: null,
      },
    ],
    actions: {
      [ImportSheetControl.actionName]: async function (this: any) {
        await ImportSheetControl.importFromCompendium(this, this.document);
      },
      ...this.ACTOR_ACTIONS_AND_CONTROLS.showPortraitArtwork.action,
      ...this.ACTOR_ACTIONS_AND_CONTROLS.showTokenArtwork.action,
      ...this.ACTOR_ACTIONS_AND_CONTROLS.openTabSelection.action,
    },
    submitOnClose: true,
  };

  itemFilterService: ItemFilterService;
  #inlineToggleService = new InlineToggleService();

  _createComponent(node: HTMLElement): Record<string, any> {
    const component = mount(GroupSheet, {
      target: node,
      context: new Map<any, any>([
        [CONSTANTS.SVELTE_CONTEXT.CONTEXT, this._context],
        [
          CONSTANTS.SVELTE_CONTEXT.INLINE_TOGGLE_SERVICE,
          this.#inlineToggleService,
        ],
        [CONSTANTS.SVELTE_CONTEXT.ITEM_FILTER_SERVICE, this.itemFilterService],
        [CONSTANTS.SVELTE_CONTEXT.LOCATION, ''],
        [
          CONSTANTS.SVELTE_CONTEXT.ON_FILTER,
          this.itemFilterService.onFilter.bind(this.itemFilterService),
        ],
        [
          CONSTANTS.SVELTE_CONTEXT.ON_FILTER_CLEAR_ALL,
          this.itemFilterService.onFilterClearAll.bind(this.itemFilterService),
        ],
        [
          CONSTANTS.SVELTE_CONTEXT.SECTION_EXPANSION_TRACKER,
          this.sectionExpansionTracker,
        ],
      ]),
    });

    initTidy5eContextMenu(this, this.element, CONSTANTS.SHEET_LAYOUT_CLASSIC);

    return component;
  }

  _createAdditionalComponents(content: HTMLElement) {
    const windowHeader = this.element.querySelector('.window-header');
    const sheetLock = mount(SheetHeaderModeToggleV2, {
      target: windowHeader,
      anchor: windowHeader.querySelector('.window-title'),
      context: new Map<string, any>([
        [CONSTANTS.SVELTE_CONTEXT.CONTEXT, this._context],
      ]),
      props: {
        class: 'header-control',
      },
    });

    const infoCard = mount(AttachedInfoCard, {
      target: this.element,
      props: {
        sheet: this,
      },
    });

    return [sheetLock, infoCard];
  }

  async _prepareContext(
    options: TidyDocumentSheetRenderOptions
  ): Promise<GroupSheetClassicContext> {
    this.itemFilterService.refreshFilters();

    const documentSheetContext = (await super._prepareContext(
      options
    )) as DocumentSheetV2Context;

    let xp: Group5eXp | undefined = undefined;
    if (
      systemSettings.value.levelingMode !==
      CONSTANTS.SYSTEM_SETTING_LEVELING_MODE_NO_XP
    ) {
      xp = this.actor.system.details.xp;
    }

    const descriptionFullEnrichedHtml =
      await foundry.applications.ux.TextEditor.enrichHTML(
        this.actor.system.description.full,
        {
          secrets: this.actor.isOwner,
          rollData: this.actor.getRollData(),
          relativeTo: this.actor,
        }
      );

    const {
      sections: memberSections,
      stats,
      memberContext,
      groupLanguages,
      groupSkills,
      groupAbilities,
      groupMasteries,
    } = this.#prepareMembers();

    const source = this.actor.toObject();

    const editable = this.isEditable;

    const summary = this.#getSummary(stats);

    const movement = this.#prepareMovementSpeed();

    const sheetPreferences = UserSheetPreferencesService.getByType(this.actor.type);

    const membersSortMode =
      sheetPreferences.tabs?.[CONSTANTS.TAB_MEMBERS]?.sort ?? 'm';

    const inventorySortMode =
      sheetPreferences.tabs?.[CONSTANTS.TAB_ACTOR_INVENTORY]?.sort ?? 'm';

    const utilities: Utilities<GroupSheetClassicContext> = {
      [CONSTANTS.TAB_MEMBERS]: {
        utilityToolbarCommands: [
          {
            id: 'sort-mode-alpha',
            title: FoundryAdapter.localize('SIDEBAR.SortModeAlpha'),
            iconClass: 'fa-solid fa-arrow-down-a-z fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_MEMBERS,
                'sort',
                'm'
              );
            },
            visible: membersSortMode === 'a',
          },
          {
            id: 'sort-mode-manual',
            title: FoundryAdapter.localize('SIDEBAR.SortModeManual'),
            iconClass: 'fa-solid fa-arrow-down-short-wide fa-fw',
            execute: async () => {
              await UserSheetPreferencesService.setDocumentTypeTabPreference(
                this.actor.type,
                CONSTANTS.TAB_MEMBERS,
                'sort',
                'a'
              );
            },
            visible: membersSortMode === 'm',
          },
          {
            id: 'show-member-tab-info-panel',
            title: FoundryAdapter.localize(
              'TIDY5E.Group.ShowMemberTabInfoPanel'
            ),
            iconClass: 'fa-solid fa-people-group fa-fw',
            execute: async () => {
              await TidyFlags.showGroupMemberTabInfoPanel.set(this.actor, true);
            },
            visible:
              FoundryAdapter.userIsGm() &&
              !TidyFlags.showGroupMemberTabInfoPanel.get(this.actor),
          },
          {
            id: 'hide-member-tab-info-panel',
            title: FoundryAdapter.localize(
              'TIDY5E.Group.HideMemberTabInfoPanel'
            ),
            iconClass: 'fa-solid fa-people-group fa-fw active',
            execute: async () => {
              await TidyFlags.showGroupMemberTabInfoPanel.unset(this.actor);
            },
            visible:
              FoundryAdapter.userIsGm() &&
              TidyFlags.showGroupMemberTabInfoPanel.get(this.actor),
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
                  tabTitle: GroupSheetClassicRuntime.getTabTitle(
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
      [CONSTANTS.TAB_GROUP_BASTIONS]: {
        utilityToolbarCommands: [
          {
            id: 'take-bastion-turn',
            title: FoundryAdapter.localize('DND5E.Bastion.Action.Advance'),
            iconClass: 'fa-solid fa-calendar-clock fa-fw',
            text: FoundryAdapter.localize('DND5E.Bastion.Action.Advance'),
            execute: () => this.takeBastionTurn(),
            visible: FoundryAdapter.userIsGm(),
          },
        ],
      },
    };

    const uncontainedItems: Item5e[] = Array.from(this.actor.items).filter(
      (i: Item5e) => !this.actor.items.has(i.system.container)
    );

    const inventoryTypesArray = Inventory.getInventoryTypes();
    const inventoryTypes = new Set(inventoryTypesArray);
    const inventory: ActorInventoryTypes =
      Inventory.getDefaultInventorySections();

    for (let item of uncontainedItems) {
      if (inventoryTypes.has(item.type)) {
        Inventory.applyInventoryItemToSection(
          inventory,
          item,
          inventoryTypesArray,
          {
            canCreate: true,
          }
        );
      }
    }

    SheetSections.getFilteredGlobalSectionsToShowWhenEmpty(
      this.actor,
      CONSTANTS.TAB_ACTOR_INVENTORY
    ).forEach((s) => {
      inventory[s] ??= Inventory.createInventorySection(
        s,
        inventoryTypesArray,
        {
          canCreate: true,
        }
      );
    });

    for (const pinTabId of [
        CONSTANTS.TAB_MEMBERS,
        CONSTANTS.TAB_ACTOR_INVENTORY,
        CONSTANTS.TAB_GROUP_BASTIONS,
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

    let context: GroupSheetClassicContext = {
      actor: this.actor,
      actorPortraitCommands:
        ActorPortraitRuntime.getEnabledPortraitMenuCommands(this.actor),
      bastionsContext: await this.#prepareBastions(memberContext),
      canObserveAll: Object.values(memberContext).every((m) => m.canObserve),
      config: CONFIG.DND5E,
      containerPanelItems: await Inventory.getContainerPanelItems(
        uncontainedItems
      ),
      customContent: [],
      currentHP: stats.currentHP,
      descriptionFullEnrichedHtml: descriptionFullEnrichedHtml,
      disableExperience:
        systemSettings.value.levelingMode ===
        CONSTANTS.SYSTEM_SETTING_LEVELING_MODE_NO_XP,
      allowEffectsManagement:
        FoundryAdapter.allowCharacterEffectsManagement(this.actor),
      effects: dnd5e.applications.components.EffectsElement.prepareCategories(
        this.actor.allApplicableEffects()
      ),
      filterData: this.itemFilterService.getFilterData(),
      filterPins: ItemFilterRuntime.defaultFilterPins[this.actor.type],
      groupLanguages: groupLanguages,
      groupSkills: groupSkills,
      groupAbilities: groupAbilities,
      groupMasteries: groupMasteries,
      healthPercentage: getPercentage(stats.currentHP, stats.maxHP),
      inventory: Object.values(inventory),
      isGM: game.user.isGM,
      itemContext: {},
      items: Array.from(this.actor.items),
      limited: this.actor.limited,
      lockSensitiveFields:
        (!documentSheetContext.unlocked && settings.value.useTotalSheetLock) ||
        !editable,
      tabSheetPins: await SheetPinsProvider.getTabSheetPinsContext(this.actor),
      maxHP: stats.maxHP,
      memberContext: memberContext,
      memberSections: memberSections,
      modernRules: FoundryAdapter.checkIfModernRules(this.actor),
      movement: movement,
      owner: this.actor.isOwner,
      showContainerPanel:
        TidyFlags.showContainerPanel.get(this.actor) === true &&
        Array.from(uncontainedItems).some(
          (i: Item5e) => i.type === CONSTANTS.ITEM_TYPE_CONTAINER
        ),
      showGroupMemberTabInfoPanel: TidyFlags.showGroupMemberTabInfoPanel.get(
        this.actor
      ),
      summary: summary,
      system: this.actor.system,
      tabs: [],
      useClassicControls: true, // TODO: Establish setting for this; and group section in settings
      useRoundedPortraitStyle: [
        CONSTANTS.CIRCULAR_PORTRAIT_OPTION_ALL as string,
      ].includes(settings.value.useCircularPortraitStyle),
      utilities: utilities,
      xp: xp,
      ...documentSheetContext,
    };

    context.customContent = await GroupSheetClassicRuntime.getContent(context);

    await this._prepareItems(context);

    let tabs = await GroupSheetClassicRuntime.getTabs(context);

    const selectedTabs = TidyFlags.selectedTabs.get(context.actor);

    if (selectedTabs?.length) {
      tabs = tabs
        .filter((t) => selectedTabs?.includes(t.id))
        .sort(
          (a, b) => selectedTabs.indexOf(a.id) - selectedTabs.indexOf(b.id)
        );
    } else {
      const defaultTabs: string[] = settings.value.defaultGroupSheetTabs;
      tabs = tabs
        .filter((t) => defaultTabs?.includes(t.id))
        .sort((a, b) => defaultTabs.indexOf(a.id) - defaultTabs.indexOf(b.id));
    }

    context.tabs = tabs;

    return context;
  }

  #getSummary(stats: MemberStats) {
    const formatter = game.i18n.getListFormatter({
      style: 'long',
      type: 'conjunction',
    });
    const rule = new Intl.PluralRules(game.i18n.lang);
    const members = [];
    if (stats.memberCount) {
      members.push(
        `${stats.memberCount} ${game.i18n.localize(
          `DND5E.Group.Member.${rule.select(stats.memberCount)}`
        )}`
      );
    }
    if (stats.vehicleCount) {
      members.push(
        `${stats.vehicleCount} ${game.i18n.localize(
          `DND5E.Group.Vehicle.${rule.select(stats.vehicleCount)}`
        )}`
      );
    }
    if (!members.length) return game.i18n.localize('DND5E.GroupSummaryEmpty');
    return game.i18n.format('DND5E.GroupSummary', {
      members: formatter.format(members),
    });
  }

  /**
   * Quietly refreshes the given members via a long rest and re-renders.
   * Intended for the GM-only "refresh all NPCs" section action.
   */
  async refreshMembers(members: Actor5e[]) {
    await Promise.all(members.map((member) => refreshActor(member)));
    this.render();
  }

  #prepareMembers(): {
    sections: GroupMemberSection[];
    stats: MemberStats;
    memberContext: GroupSheetClassicContext['memberContext'];
    groupLanguages: GroupLanguage[];
    groupSkills: GroupSkill[];
    groupAbilities: GroupAbility[];
    groupMasteries: GroupLanguage[];
  } {
    const stats: MemberStats = {
      currentHP: 0,
      maxHP: 0,
      memberCount: 0,
      vehicleCount: 0,
    };

    const sections: Record<string, GroupMemberSection> = {
      character: {
        label: `${CONFIG.Actor.typeLabels.character}Pl`,
        members: [],
        dataset: {},
        key: 'character',
        show: true,
        custom: undefined,
        isExternal: false,
        showCrColumn: false,
        rowActions: [], // for the UI Overhaul
        sectionActions: [], // for the UI Overhaul
      },
      npc: {
        label: `${CONFIG.Actor.typeLabels.npc}Pl`,
        members: [],
        dataset: {},
        key: 'npc',
        show: true,
        custom: undefined,
        isExternal: false,
        showCrColumn: true,
        rowActions: [], // for the UI Overhaul
        sectionActions: [], // for the UI Overhaul
      },
      vehicle: {
        label: `${CONFIG.Actor.typeLabels.vehicle}Pl`,
        members: [],
        dataset: {},
        key: 'vehicle',
        show: true,
        custom: undefined,
        isExternal: false,
        showCrColumn: false,
        rowActions: [], // for the UI Overhaul
        sectionActions: [], // for the UI Overhaul
      },
    };

    const memberContext: GroupSheetClassicContext['memberContext'] = {};
    const groupLanguages: Record<string, GroupLanguage> = {};
    const groupMasteries: Record<string, GroupLanguage> = {};
    const groupSkills: Record<string, GroupSkill> = {};
    const groupAbilities = this.#createGroupAbilityMap();
    const collectAggregates = FoundryAdapter.userIsGm();
    const configuredSkills = Object.entries(CONFIG.DND5E.skills);

    for (const [index, memberData] of this.actor.system.members.entries()) {
      const ctx: GroupMemberContext = (memberContext[memberData.actor.id] = {
        index: index,
        canObserve: memberData.actor.testUserPermission(
          game.user,
          CONSTANTS.PERMISSION_OBSERVER
        ),
        senses: [],
        conditionImmunities: [],
        topSkills: [],
      });

      const member = memberData.actor;
      const hp = member.system.attributes.hp;

      const memberCurrentHp = hp.value + (hp.temp || 0);
      const memberMaxHp = Math.max(0, hp.effectiveMax);

      stats.currentHP += memberCurrentHp;
      stats.maxHP += memberMaxHp;

      if (member.type === 'vehicle') {
        stats.vehicleCount += 1;
      } else {
        stats.memberCount += 1;
      }

      sections[member.type].members.push(member);

      if (collectAggregates) {
        const masteryValue =
          member.system.traits?.weaponProf?.mastery?.value;
        const masteryKeys =
          masteryValue instanceof Set || Array.isArray(masteryValue)
            ? [...masteryValue]
            : Object.keys(masteryValue ?? {}).filter(
                (k) => masteryValue[k],
              );
        for (const key of masteryKeys) {
          const label =
            CONFIG.DND5E.weaponMasteries?.[key]?.label ??
            dnd5e.documents.Trait.keyLabel(key, { trait: 'weapon' }) ??
            key;

          const groupMastery = (groupMasteries[label] ??=
            this.#createEmptyGroupLanguage(label));

          groupMastery.members.push(member);
        }
      }

      if (collectAggregates && member.system.traits?.languages?.value) {
        const customLanguageString =
          member.system.traits.languages.custom?.trim();
        const customLanguages = isNil(customLanguageString, '')
          ? []
          : dnd5e.utils.splitSemicolons(customLanguageString);
        const languageKeys = [
          ...member.system.traits.languages.value,
          ...customLanguages,
        ];

        for (let key of languageKeys) {
          const language = dnd5e.documents.Trait.keyLabel(key, {
            trait: 'languages',
          });

          const groupLanguage = (groupLanguages[language] ??=
            this.#createEmptyGroupLanguage(language));

          groupLanguage.members.push(member);
        }
      }

      if (collectAggregates && member.system.skills) {
        for (let [key, skill] of Object.entries<any>(member.system.skills)) {
          const groupSkill = (groupSkills[key] ??=
            this.#createEmptyGroupSkill(key));

          groupSkill.total = Math.max(groupSkill.total, skill.total);
          groupSkill.members.push(member);
        }
      }

      if (collectAggregates) {
        this.#prepareMemberAbilities(member, groupAbilities);
      }

      if (ctx.canObserve) {
        // Member Senses
        const senses = member.system.attributes.senses ?? {};
        const tags: Record<string, string> = {};
        for (let [k, label] of Object.entries(CONFIG.DND5E.senses)) {
          const v = getSenseRange(senses, k) ?? 0;
          if (v === 0) continue;
          tags[k] = `${getSenseLabel(label)} ${v} ${
            CONFIG.DND5E.movementUnits[senses.units]?.abbreviation ??
            Object.values(CONFIG.DND5E.movementUnits)[0].abbreviation
          }`;
        }
        if (senses.special)
          dnd5e.utils
            .splitSemicolons(senses.special)
            .forEach(
              (c: string, i: number) => (tags[`custom${i + 1}`] = c.trim())
            );
        ctx.senses = Object.values(tags);

        // Member Condition Immunities
        const conditionImmunities: string[] = [];
        for (let entry of member.system.traits.ci.value) {
          conditionImmunities.push(
            CONFIG.DND5E.conditionTypes[entry]?.name ?? entry
          );
        }

        const customImmunity = member.system.traits.ci.custom?.trim();
        if (!isNil(customImmunity, '')) {
          conditionImmunities.push(customImmunity);
        }

        ctx.conditionImmunities = conditionImmunities;

        // Perception and Top Skills

        let skills: GroupMemberSkillInfo[];
        skills = member.system.skills
          ? Array.from(configuredSkills).reduce<GroupMemberSkillInfo[]>(
              (prev, [key, configSkill]: [string, any]) => {
                const skill = this.#getSkill(member, key);

                if (!skill) {
                  warn(
                    'Unable to find skill. Ensure custom skills are added at "init" time.',
                    false,
                    { key, configSkill }
                  );
                  return prev;
                }

                const label =
                  CONFIG.DND5E.skills[key as keyof typeof CONFIG.DND5E.skills]
                    ?.label ?? key;

                prev.push({
                  key: key,
                  label: label,
                  passive: skill.passive,
                  total: skill.total,
                  formattedTotal: formatAsModifier(skill.total),
                });

                return prev;
              },
              []
            )
          : [];

        ctx.topSkills = skills
          .filter((s) => s.key !== CONSTANTS.SKILL_KEY_PERCEPTION)
          .sort((a, b) => b.total - a.total)
          .slice(0, 4);

        ctx.perception = skills.find(
          (s) => s.key === CONSTANTS.SKILL_KEY_PERCEPTION
        );
      }
    }

    return {
      sections: Object.values(sections).filter((s) => s.members.length > 0),
      stats: stats,
      memberContext: memberContext,
      groupLanguages: Object.values(groupLanguages).sort((a, b) =>
        a.label.localeCompare(b.label, game.i18n.lang)
      ),
      groupSkills: Object.values(groupSkills).sort((a, b) =>
        a.label.localeCompare(b.label, game.i18n.lang)
      ),
      groupAbilities: [...groupAbilities.values()],
      groupMasteries: Object.values(groupMasteries).sort((a, b) =>
        a.label.localeCompare(b.label, game.i18n.lang)
      ),
    };
  }

  #createGroupAbilityMap(): Map<string, GroupAbility> {
    return new Map<string, GroupAbility>(
      Object.entries(CONFIG.DND5E.abilities).map(
        ([key, ability]: [string, any]) => [
          key,
          {
            name: ability.label ?? ability.name ?? key,
            key,
            proficient: false,
            high: { total: -Infinity, value: '∞', sign: '-' },
            low: { total: Infinity, value: '∞', sign: '+' },
            saveHigh: { total: -Infinity, value: '∞', sign: '-' },
            saveLow: { total: Infinity, value: '∞', sign: '+' },
            score: -Infinity,
            members: [],
            identifiers: new Map<string, GroupMemberAbilityContext>(),
          },
        ]
      )
    );
  }

  #prepareMemberAbilities(
    member: Actor5e,
    abilities: Map<string, GroupAbility>
  ) {
    for (let [key, ability] of Object.entries<any>(
      member.system.abilities ?? {}
    )) {
      let groupAbility = abilities.get(key);

      if (!groupAbility) {
        continue;
      }

      const modData = getModifierData(ability.mod);
      const saveData = getModifierData(ability.save?.value);
      const scoreData = getModifierData(ability.value);

      if (ability.mod > groupAbility.high.total) {
        groupAbility.high = { total: ability.mod, ...modData };
      }

      if (ability.mod < groupAbility.low.total) {
        groupAbility.low = { total: ability.mod, ...modData };
      }

      if (ability.save?.value > groupAbility.saveHigh.total) {
        groupAbility.saveHigh = { total: ability.save.value, ...saveData };
      }

      if (ability.save?.value < groupAbility.saveLow.total) {
        groupAbility.saveLow = { total: ability.save.value, ...saveData };
      }

      if (ability.value > groupAbility.score) {
        groupAbility.score = ability.value;
      }

      groupAbility.identifiers.set(member.uuid, {
        mod: ability.mod,
        modSign: modData.sign,
        modValue: modData.value,
        proficient: ability.proficient,
        save: ability.save?.value,
        saveSign: saveData.sign,
        saveValue: saveData.value,
        score: ability.value,
        scoreValue: scoreData.value,
        scoreSign: scoreData.sign,
      });

      groupAbility.proficient ||= ability.proficient > 0;

      if (!groupAbility.members.includes(member)) {
        groupAbility.members.push(member);
      }
    }
  }

  #createEmptyGroupLanguage(language: any): GroupLanguage {
    return {
      label: language,
      members: [],
    };
  }

  #createEmptyGroupSkill(key: string): GroupSkill {
    return {
      key: key,
      label:
        CONFIG.DND5E.skills[key as keyof typeof CONFIG.DND5E.skills]?.label ??
        key,
      members: [],
      total: Number.NEGATIVE_INFINITY,
    };
  }

  #prepareMovementSpeed() {
    const travel = this.actor.system.attributes.travel;
    let speeds = [
      [
        travel.land,
        `${game.i18n.localize('DND5E.TRAVEL.Type.Land')} ${travel.land}`,
      ],
      [
        travel.water,
        `${game.i18n.localize('DND5E.TRAVEL.Type.Water')} ${travel.water}`,
      ],
      [
        travel.air,
        `${game.i18n.localize('DND5E.TRAVEL.Type.Air')} ${travel.air}`,
      ],
    ];
    speeds = speeds.filter((s) => s[0]).sort((a, b) => b[0] - a[0]);
    const primary = speeds.shift();
    return {
      primary: `${primary ? primary[1] : '0'}`,
      secondary: speeds.map((s) => s[1]).join(', '),
    };
  }

  #getSkill(member: Actor5e, key: string): any | null {
    if (key in member.system.skills) {
      return member.system.skills[key];
    }

    return null;
  }

  /**
   * Prepare group bastions. One entry per observable character member. Orders
   * are shared context for the group.
   *
   * GMs can prep facilities before players get access via their level, but
   * players won't see it until one of them reaches the level where bastions
   * unlock.
   */
  async #prepareBastions(
    memberContext: GroupSheetClassicContext['memberContext']
  ): Promise<GroupBastionsContext> {
    const bastionsContext: GroupBastionsContext = {
      members: [],
      orders: [],
    };

    // Skip if bastions are off.
    if (!systemSettings.value.bastionConfiguration.enabled) {
      return bastionsContext;
    }

    for (const memberData of this.actor.system.members) {
      const member = memberData.actor;

      if (member.type !== CONSTANTS.SHEET_TYPE_CHARACTER) {
        continue;
      }

      if (!memberContext[member.id]?.canObserve) {
        continue;
      }

      const { facilities } = await Bastion.prepareFacilities(member);

      const memberFacilities = [
        ...facilities.special.chosen,
        ...facilities.basic.chosen,
      ];

      bastionsContext.members.push({
        actor: member,
        name: member.system.bastion?.name ?? '',
        level: member.system.details.level,
        facilities,
        hirelings: Bastion.calculateOccupancy(
          facilities.special.chosen,
          'hirelings'
        ),
        defenders: Bastion.calculateOccupancy(
          facilities.special.chosen,
          'defenders'
        ),
      });

      for (const facility of memberFacilities) {
        if (!facility.progress.max) {
          continue;
        }

        bastionsContext.orders.push({
          facility: facility.facility,
          facilityName: facility.name,
          member,
          key: facility.progress.order,
          label:
            CONFIG.DND5E.facilities.orders[facility.progress.order]?.label ??
            facility.progress.order,
          progress: {
            value: facility.progress.value,
            max: facility.progress.max,
            pct: facility.progress.pct,
            order: facility.progress.order,
          },
          craft: facility.craft,
          cost: Bastion.getOrderCost(facility),
        });
      }
    }

    // Sort by progress
    bastionsContext.orders.sort((a, b) => b.progress.pct - a.progress.pct);

    return bastionsContext;
  }

  async _prepareItems(context: GroupSheetClassicContext) {
    for (const item of context.items) {
      if (Inventory.isItemInventoryType(item)) {
        context.itemContext[item.id] ??= await this._prepareItem(item, context);
      }
    }

    for (const panelItem of context.containerPanelItems) {
      const ctx = context.itemContext[panelItem.container.id];
      ctx.containerContents = await Container.getContainerContents(
        panelItem.container,
        {
          hasActor: false,
          unlocked: context.unlocked,
        }
      );
    }
  }

  async _prepareItem(
    item: Item5e,
    context: GroupSheetClassicContext
  ): Promise<GroupItemContext> {
    return {
      activities: Activities.getVisibleActivities(
        item,
        item.system.activities
      )?.map(Activities.getActivityItemContext),
      canToggle: false,
      containerContents: undefined,
      hasUses: item.hasLimitedUses,
      isStack: item.system.quantity > 1,
      save: ItemContext.getItemSaveContext(item),
      toHit: ItemContext.getToHit(item),
      totalWeight: (await item.system.totalWeight)?.toNearest(0.1) ?? 0,
    };
  }

  async _renderHTML(
    context: GroupSheetClassicContext,
    options: ApplicationRenderOptions
  ) {
    game.user.apps[this.id] = this;
    for (const member of this.actor.system.members) {
      member.actor.apps[this.id] = this;
    }
    return await super._renderHTML(context, options);
  }

  async close(options: ApplicationClosingOptions = {}) {
    delete game.user.apps[this.id];
    for (const member of this.actor.system.members) {
      delete member.actor.apps[this.id];
    }
    return await super.close(options);
  }

  /* -------------------------------------------- */
  /*  Drag and Drop                               */
  /* -------------------------------------------- */

  _onDragStart(
    event: DragEvent & { currentTarget: HTMLElement; target: HTMLElement }
  ): void {
    if (event.target !== event.currentTarget) {
      // Allow for draggables within this containing element to be handled elsewhere.
      return;
    }

    const memberId = event.currentTarget
      .closest('[data-tidy-draggable][data-member-id]')
      ?.getAttribute('data-member-id');

    if (!memberId) {
      super._onDragStart(event);
      return;
    }

    const actor = this.#findMemberActor(memberId);

    if (!actor) {
      return;
    }

    const dragData = actor.toDragData();
    dragData['groupId'] = this.actor.id;
    event.dataTransfer?.setData('text/plain', JSON.stringify(dragData));
  }

  async _onDropActiveEffect(
    ..._args: any[]
  ): Promise</*ActiveEffect*/ unknown | boolean> {
    // Tidy Group Sheet doesn't support active effect drops.
    return false;
  }

  async _onDropActor(
    event: DragEvent & { currentTarget: HTMLElement; target: HTMLElement },
    data: any
  ): Promise<object | boolean | undefined> {
    if (!this.isEditable) {
      return false;
    }

    // Dropping an actor on a member facility's occupant slot assigns them
    // there instead of adding them to the group.
    const occupantTarget = event.target?.closest<HTMLElement>(
      '[data-occupant-slot][data-member-uuid]'
    );

    if (occupantTarget && data.uuid) {
      const memberUuid = occupantTarget.dataset.memberUuid;
      const member = memberUuid ? fromUuidSync(memberUuid) : undefined;
      const facilityId =
        occupantTarget.closest<HTMLElement>('[data-facility-id]')?.dataset
          .facilityId;
      const slot = occupantTarget.dataset.occupantSlot as
        | FacilityOccupantSlot
        | undefined;
      const prop = slot ? FacilityOccupantSlotPropsMap[slot] : undefined;

      if (!member || !prop) {
        return false;
      }

      const facility = facilityId
        ? member.items.get(facilityId)
        : await this.#promptForFacilityWithOpenSlot(member, slot!);

      if (facility) {
        return await Bastion.addFacilityOccupant(facility, prop, data.uuid);
      }

      return false;
    }

    const cls = getDocumentClass('Actor');
    const sourceActor = await cls.fromDropData(data);
    if (!sourceActor) {
      return;
    }

    const groupId = data['groupId'];

    if (groupId !== this.actor.id) {
      return this.actor.system.addMember(sourceActor);
    }

    const dropTarget = event.target?.closest<HTMLElement>(
      '[data-tidy-draggable][data-member-id]'
    );
    const targetMemberId = dropTarget?.getAttribute('data-member-id');

    const targetMemberActor = this.#findMemberActor(targetMemberId);

    if (
      !dropTarget ||
      !targetMemberActor ||
      targetMemberId === sourceActor.id
    ) {
      return false;
    }

    return await this._onSortMember(sourceActor, targetMemberActor);
  }

  #findMemberActor(actorId: string | null | undefined): Actor5e | undefined {
    return this.actor.system.members.find(
      (m: Group5eMember) => m.actor.id === actorId
    )?.actor;
  }

  async _onSortMember(sourceActor: Actor5e, targetActor: Actor5e) {
    const membersCollection: Group5eMember[] =
      this.actor.system.toObject().members;
    const sourceIndex = membersCollection.findIndex(
      (m) => m.actor === sourceActor.id
    );
    const targetIndex = membersCollection.findIndex(
      (m) => m.actor === targetActor.id
    );

    const sortBefore = sourceIndex > targetIndex;

    if (sortBefore) {
      const sourceMember = membersCollection.splice(sourceIndex, 1)[0];
      membersCollection.splice(targetIndex, 0, sourceMember);
    } else {
      const sourceMember = membersCollection[sourceIndex];
      membersCollection.splice(targetIndex + 1, 0, sourceMember);
      membersCollection.splice(sourceIndex, 1);
    }

    return await this.actor.update({ 'system.members': membersCollection });
  }

  async _onDropFolder(
    event: DragEvent & { currentTarget: HTMLElement; target: HTMLElement },
    data: Record<string, any>
  ) {
    if (!this.isEditable) {
      return false;
    }

    const folder = await Folder.implementation.fromDropData(data);

    if (folder.type === 'Actor') {
      const results: any[] = [];
      for (let actor of folder.contents) {
        results.push(await this.actor.system.addMember(actor));
      }
      return results;
    }

    return await super._onDropFolder(event, data);
  }

  // ---------------------------------------------
  // Actions
  // ---------------------------------------------

  onRollAbility(options: { ability: string; event: Event }) {
    if (
      !FoundryAdapter.userIsGm() ||
      TidyHooks.tidy5eSheetsPrePromptGroupAbilityRoll(this, options) === false
    ) {
      return;
    }

    return this.rollAbility(options);
  }

  async rollAbility(config: { ability: string }) {
    if (!config.ability) {
      return;
    }

    const abilityConfig = CONFIG.DND5E.abilities[config.ability];
    const abilityLabel = (abilityConfig as any)?.label ?? '';

    await foundry.documents.ChatMessage.implementation.create({
      flavor: FoundryAdapter.localize('DND5E.AbilityPromptTitle', {
        ability: abilityLabel,
      }),
      speaker: ChatMessage.getSpeaker({
        actor: this.actor,
        alias: this.actor.name,
      }),
      system: {
        button: {
          icon: 'fa-solid fa-dice-d20',
          label: FoundryAdapter.localize('TIDY5E.ACTOR.Ability.Action.Roll', {
            ability: abilityLabel,
          }),
        },
        data: { ...config },
        handler: CONSTANTS.ROLL_REQUEST_ABILITY_KEY,
        targets: this.actor.system.members.flatMap(
          ({ actor }: { actor: Actor5e }) =>
            actor?.system.abilities ? [{ actor: actor.uuid }] : []
        ),
      },
      type: 'request',
    });

    return false;
  }

  onRollSavingThrow(options: { ability: string; event: Event }) {
    if (
      !FoundryAdapter.userIsGm() ||
      TidyHooks.tidy5eSheetsPrePromptGroupSavingThrowRoll(this, options) ===
        false
    ) {
      return;
    }

    return this.rollSavingThrow(options);
  }

  async rollSavingThrow(config: { ability: string }) {
    if (!config.ability) {
      return;
    }

    await this.document.system.rollSavingThrow(config);

    return false;
  }

  award() {
    const award = new dnd5e.applications.Award({
      award: {
        savedDestinations: this.actor.getFlag('dnd5e', 'awardDestinations'),
      },
      origin: this.actor,
    });

    award.render(true);
  }

  /* -------------------------------------------- */
  /*  Bastions                                    */
  /* -------------------------------------------- */

  /**
   * Advance a bastion turn for characters in this group only. Not the whole world.
   *
   * Mirrors `dnd5e.bastion.confirmAdvance()`, which can't be reused here because
   * it's world-level.
   */
  async takeBastionTurn() {
    if (!FoundryAdapter.userIsGm()) {
      return;
    }

    const proceed = await foundry.applications.api.DialogV2.confirm({
      content: FoundryAdapter.localize('TIDY5E.BASTION.Group.Confirm.TakeTurn'),
      rejectClose: false,
      window: {
        icon: 'fa-solid fa-chess-rook',
        title: 'DND5E.Bastion.Action.Advance',
      },
    });

    if (!proceed) {
      return;
    }

    const members = this.actor.system.members
      .map(({ actor }: { actor: Actor5e }) => actor)
      .filter((actor: Actor5e) => !!actor);

    const maintainUuids = await BastionMaintainOrderDialog.prompt(
      members.filter((actor: Actor5e) => actor.itemTypes.facility?.length),
      (dialog) => dialog.render({ force: true })
    );

    if (maintainUuids === null) {
      return;
    }

    return await Bastion.advanceBastions(members, { maintainUuids });
  }

  async issueMemberMaintainOrder(member: Actor5e) {
    if (!FoundryAdapter.userIsGm() || !member.itemTypes.facility?.length) {
      return;
    }

    return await Bastion.issueMaintainOrder(member);
  }

  /** Issue an order to a facility owned by a group member. */
  async useMemberFacility(
    member: Actor5e,
    facilityId: string | undefined,
    event: Event
  ) {
    if (!this.isEditable) {
      return;
    }

    return await Bastion.useFacility({
      actor: member,
      facilityId,
      event,
      sheet: this,
    });
  }

  /**
   * Nudge a member facility's order along by a day, for GMs correcting the
   * record. Serves the facilities list and the orders list.
   */
  async adjustMemberFacilityProgress(args: {
    memberUuid: string | undefined;
    facilityId: string | undefined;
    toAdjust: number;
  }) {
    if (!FoundryAdapter.userIsGm()) {
      return;
    }

    const { memberUuid, facilityId, toAdjust } = args;

    const member = memberUuid ? fromUuidSync(memberUuid) : undefined;

    const facility = facilityId ? member?.items.get(facilityId) : undefined;

    if (
      !facility ||
      !facility.isOwner ||
      FoundryAdapter.isLockedInCompendium(facility)
    ) {
      return;
    }

    const { value, max } = facility.system.progress;

    if (Number.isNaN(toAdjust) || !max) {
      return;
    }

    const next = Math.clamp(value + toAdjust, 0, max);

    if (next === value) {
      return;
    }

    // If you hit the last day, check if the user wants to complete the order.
    if (toAdjust > 0 && next >= max) {
      const proceed = await Bastion.confirmCompleteOrder();

      if (!proceed) {
        return;
      }

      return await Bastion.completeOrder(facility);
    }

    return await facility.update({ 'system.progress.value': next });
  }

  async completeMemberFacilityOrder(facility: Item5e) {
    if (
      !FoundryAdapter.userIsGm() ||
      !facility.isOwner ||
      FoundryAdapter.isLockedInCompendium(facility)
    ) {
      return;
    }

    return await Bastion.completeOrder(facility);
  }

  /**
   * Browse for a facility and create it on the member. GM only, so it ignores
   * level restrictions.
   */
  async addMemberFacility(member: Actor5e, facilityType: string, event: Event) {
    if (!this.isEditable) {
      return;
    }

    return await Bastion.addFacility({
      actor: member,
      facilityType,
      event,
      ignoreLevelRestriction: true,
      onSelected: (itemData) =>
        dnd5e.documents.Item5e.createDocuments([itemData], {
          pack: member.pack,
          parent: member,
          keepId: true,
        }),
    });
  }

  /**
   * Fill an open occupant slot on a member's facility.
   *
   * Facility rows identify their facility directly. The member header row shows
   * an occupancy total across every special facility, so it has no single
   * target and prompts for one instead.
   */
  async addMemberFacilityOccupant(
    memberUuid: string | undefined,
    slot: FacilityOccupantSlot | undefined,
    event: Event,
    facilityId?: string
  ) {
    const member = memberUuid ? fromUuidSync(memberUuid) : undefined;

    if (!member || !slot) {
      return;
    }

    const facility = facilityId
      ? member.items.get(facilityId)
      : await this.#promptForFacilityWithOpenSlot(member, slot);

    if (
      !facility ||
      !facility.isOwner ||
      FoundryAdapter.isLockedInCompendium(facility)
    ) {
      return;
    }

    const prop = FacilityOccupantSlotPropsMap[slot];

    if (
      !TidyHooks.tidy5eSheetsFacilityEmptyOccupantSlotClicked(
        event,
        facility,
        FacilityOccupantSlotTypesMap[slot],
        prop
      )
    ) {
      return;
    }

    const result = await dnd5e.applications.CompendiumBrowser.selectOne({
      filters: {
        locked: {
          documentClass: 'Actor',
          types: new Set(['character', 'npc', 'vehicle', 'group']),
        },
      },
      // Have to specify a tab now, otherwise it defaults to items and fails.
      tab: 'actors',
    });

    if (result) {
      await Bastion.addFacilityOccupant(facility, prop, result);
    }
  }

  /**
   * Ask which of a member's facilities should receive the occupant. Resolves
   * without prompting when there is only one candidate.
   */
  async #promptForFacilityWithOpenSlot(
    member: Actor5e,
    slot: FacilityOccupantSlot
  ): Promise<Item5e | undefined> {
    const candidates = Bastion.getFacilitiesWithOpenSlot(member, slot);

    if (candidates.length <= 1) {
      return candidates[0];
    }

    // Built through the DOM so facility names are escaped for us.
    const select = document.createElement('select');
    select.name = 'facilityId';
    for (const facility of candidates) {
      const option = document.createElement('option');
      option.value = facility.id;
      option.textContent = facility.name;
      select.appendChild(option);
    }

    const { promise, resolve } = Promise.withResolvers<string | undefined>();

    const dialog = new foundry.applications.api.DialogV2({
      content: `<div class="form-group">${select.outerHTML}</div>`,
      window: {
        icon: 'fa-solid fa-house-turret',
        title: FoundryAdapter.localize(
          'TIDY5E.BASTION.Group.ChooseFacility.Title'
        ),
      },
      buttons: [
        {
          action: 'choose',
          icon: 'fa-solid fa-check',
          label: FoundryAdapter.localize('Confirm'),
          default: true,
          callback: (_event: Event, button: HTMLButtonElement) =>
            new foundry.applications.ux.FormDataExtended(button.form).object
              .facilityId as string | undefined,
        },
      ],
      submit: (result: string | undefined) => resolve(result),
    });

    dialog.addEventListener('close', () => resolve(undefined), { once: true });

    dialog.render({ force: true });

    const chosenId = await promise;

    return chosenId ? member.items.get(chosenId) : undefined;
  }

  /**
   * Open a member's own sheet on their bastion tab, so a GM can jump from the
   * party overview straight to the facilities they were reading.
   */
  viewBastionMember(member: Actor5e) {
    if (!Bastion.characterHasBastionTab(member)) {
      member.sheet.render(true);
      return;
    }

    member.sheet.emphasizedTabId = CONSTANTS.TAB_CHARACTER_BASTION;
    member.sheet.render(true);
  }
}
