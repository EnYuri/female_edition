import type { Actor5e } from 'src/types/types';
import type { ContextMenuEntry } from 'src/foundry/foundry.types';
import type { Encounter5eMember } from 'src/types/group.types';
import { TidyHooks } from 'src/foundry/TidyHooks';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import { getEncounterMemberContextOptionsQuadrone } from './tidy5e-encounter-context-menu-quadrone';

export function configureEncounterContextMenu(element: HTMLElement, app: any) {
  const memberId = element.getAttribute('data-member-uuid');
  const memberEntry = app.document.system.members.find(
    (m: Encounter5eMember) => m.uuid === memberId
  );

  const memberPromise = fromUuid(memberEntry.uuid);

  if (!memberPromise) return;

  const isQuadroneSheet = element.closest('.quadrone');

  ui.context.menuItems = isQuadroneSheet
    ? getEncounterMemberContextOptionsQuadrone(app.document, memberPromise)
    : getEncounterMemberContextOptions(app.document, memberPromise);

  TidyHooks.tidy5eSheetsGetEncounterMemberContextOptions(
    app.document,
    memberPromise,
    ui.context.menuItems
  );
}

/**
 * Prepare an array of context menu options which are available for a member of an encounter.
 * @param encounter    The encounter for which the context menu is activated.
 * @param memberPromise    The actor for whom the context menu is activate.
 * @returns        Context menu options.
 */
function getEncounterMemberContextOptions(
  encounter: Actor5e,
  memberPromise: Promise<Actor5e>
): ContextMenuEntry[] {
  let options: ContextMenuEntry[] = [
    {
      name: 'DND5E.Group.Action.View',
      icon: `<i class="fas fa-eye fa-fw"></i>`,
      callback: async () => (await memberPromise)?.sheet.render(true),
      condition: () =>
        encounter.isOwner && !FoundryAdapter.isLockedInCompendium(encounter),
      group: 'common',
    },
    {
      name: 'DND5E.HPFormulaRollMessage',
      icon: `<i class="fas fa-dice-d6 fa-fw"></i>`,
      callback: async () => {
        const member = await memberPromise;

        try {
          const roll = await member.rollNPCHitPoints();

          const updates: Record<string, any> = {
            'system.attributes.hp.max': roll.total,
          };

          if (
            member.system.attributes.hp.value ===
            member.system.attributes.hp.max
          ) {
            updates['system.attributes.hp.value'] = roll.total;
          }

          await member.update(updates);
        } catch (error) {
          ui.notifications.error('DND5E.HPFormulaError', { localize: true });
          return;
        }

        encounter.sheet.render();
      },
      condition: () =>
        encounter.isOwner && !FoundryAdapter.isLockedInCompendium(encounter),
      group: 'action',
    },
    {
      name: 'DND5E.Group.Action.Remove',
      icon: `<i class="fas fa-trash fa-fw t5e-warning-color"></i>`,
      callback: async () =>
        await encounter.system.removeMember(await memberPromise),
      condition: () =>
        encounter.isOwner && !FoundryAdapter.isLockedInCompendium(encounter),
      group: 'be-careful',
    },
  ];

  return options;
}
