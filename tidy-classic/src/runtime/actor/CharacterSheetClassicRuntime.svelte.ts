import type { CharacterSheetContext } from 'src/types/types';
import { ActorSheetRuntime } from '../ActorSheetRuntime.svelte';
import CharacterAttributesTab from 'src/sheets/classic/character/tabs/CharacterAttributesTab.svelte';
import CharacterBastionTab from 'src/sheets/classic/character/tabs/CharacterBastionTab.svelte';
import ActorInventoryTab from 'src/sheets/classic/actor/tabs/ActorInventoryTab.svelte';
import CharacterSpellbookTab from 'src/sheets/classic/character/tabs/CharacterSpellbookTab.svelte';
import CharacterFeaturesTab from 'src/sheets/classic/character/tabs/CharacterFeaturesTab.svelte';
import CharacterSheetTab from 'src/sheets/classic/character/tabs/CharacterSheetTab.svelte';
import CharacterEffectsTab from 'src/sheets/classic/character/tabs/CharacterEffectsTab.svelte';
import CharacterBiographyTab from 'src/sheets/classic/character/tabs/CharacterBiographyTab.svelte';
import ActorJournalTab from 'src/sheets/classic/actor/tabs/ActorJournalTab.svelte';
import SpecialTraitsTab from 'src/sheets/classic/actor/tabs/SpecialTraitsTab.svelte';
import ActorActionsTab from 'src/sheets/classic/actor/tabs/ActorActionsTab.svelte';
import { CONSTANTS } from 'src/constants';
import type { RegisteredTab } from '../types';
import { systemSettings } from 'src/settings/settings.svelte';
import { characterHasBastionTab } from 'src/features/facility/Bastion';

const defaultClassicCharacterTabs: RegisteredTab<CharacterSheetContext>[] = [
  {
    title: 'TIDY5E.Actions.TabName',
    content: {
      component: ActorActionsTab,
      type: 'svelte',
    },
    id: CONSTANTS.TAB_ACTOR_ACTIONS,
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_CHARACTER_SHEET,
    title: 'TIDY5E.SheetTabName',
    content: {
      component: CharacterSheetTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_CHARACTER_ATTRIBUTES,
    title: 'DND5E.Attributes',
    content: {
      component: CharacterAttributesTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_ACTOR_INVENTORY,
    title: 'DND5E.Inventory',
    content: {
      component: ActorInventoryTab,
      type: 'svelte',
      getProps() {
        return {
          tabId: CONSTANTS.TAB_ACTOR_INVENTORY,
        };
      },
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_ACTOR_SPELLBOOK,
    title: 'DND5E.Spellbook',
    content: {
      component: CharacterSpellbookTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_CHARACTER_FEATURES,
    title: 'DND5E.Features',
    content: {
      component: CharacterFeaturesTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_EFFECTS,
    title: 'DND5E.Effects',
    content: {
      component: CharacterEffectsTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_ACTOR_BIOGRAPHY,
    title: 'DND5E.Biography',
    content: {
      component: CharacterBiographyTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_CHARACTER_JOURNAL,
    title: 'TIDY5E.JournalTabName',
    content: {
      component: ActorJournalTab,
      type: 'svelte',
    },
    enabled: (context) => context.owner,
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_CHARACTER_BASTION,
    title: 'DND5E.Bastion.Label',
    content: {
      component: CharacterBastionTab,
      type: 'svelte',
    },
    enabled: (context) => characterHasBastionTab(context.actor),
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_ACTOR_SPECIAL_TRAITS,
    title: 'DND5E.SpecialTraits',
    content: {
      component: SpecialTraitsTab,
      type: 'svelte',
    },
    layout: 'classic',
    iconClass: 'fa-solid fa-star',
  },
];

const singleton = new ActorSheetRuntime<CharacterSheetContext>(
  defaultClassicCharacterTabs,
  []
);

export default singleton;
