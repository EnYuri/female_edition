import type { GroupSheetClassicContext } from 'src/types/group.types';
import { ActorSheetRuntime } from '../ActorSheetRuntime.svelte';
import { CONSTANTS } from 'src/constants';
import type { RegisteredTab } from '../types';
import GroupMembersTab from 'src/sheets/classic/group/tabs/GroupMembersTab.svelte';
import GroupInventoryTab from 'src/sheets/classic/group/tabs/GroupInventoryTab.svelte';
import GroupBastionsTab from 'src/sheets/classic/group/tabs/GroupBastionsTab.svelte';
import GroupDescriptionTab from 'src/sheets/classic/group/tabs/GroupDescriptionTab.svelte';
import ActorEffectsTab from 'src/sheets/classic/actor/ActorEffectsTab.svelte';
import { systemSettings } from 'src/settings/settings.svelte';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import { getUnlockThresholdLevel } from 'src/features/facility/Bastion';

const defaultGroupClassicTabs: RegisteredTab<GroupSheetClassicContext>[] = [
  {
    id: CONSTANTS.TAB_MEMBERS,
    title: 'DND5E.Group.Member.other',
    content: {
      component: GroupMembersTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_ACTOR_INVENTORY,
    title: 'DND5E.Inventory',
    content: {
      component: GroupInventoryTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_GROUP_BASTIONS,
    title: 'DND5E.Bastion.Configuration.Name',
    content: {
      component: GroupBastionsTab,
      type: 'svelte',
    },
    enabled: (context) => {
      if (!systemSettings.value.bastionConfiguration.enabled) {
        return false;
      }

      const members = context.bastionsContext.members;

      if (!members.length) {
        return false;
      }

      if (FoundryAdapter.userIsGm()) {
        return true;
      }

      const threshold = getUnlockThresholdLevel();
      return members.some((m) => m.level >= threshold);
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_EFFECTS,
    title: 'DND5E.Effects',
    content: {
      component: ActorEffectsTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
  {
    id: CONSTANTS.TAB_DESCRIPTION,
    title: 'DND5E.Description',
    content: {
      component: GroupDescriptionTab,
      type: 'svelte',
    },
    layout: 'classic',
  },
];

const singleton = new ActorSheetRuntime<GroupSheetClassicContext>(
  defaultGroupClassicTabs,
  []
);

export default singleton;
