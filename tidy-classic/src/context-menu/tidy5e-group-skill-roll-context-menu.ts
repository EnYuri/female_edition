import type { ContextMenuEntry } from 'src/foundry/foundry.types';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import { TidyHooks } from 'src/foundry/TidyHooks';
import { settings } from 'src/settings/settings.svelte';

export function configureGroupSkillRollContextMenu(
  element: HTMLElement,
  app: { document: any }
) {
  const skillKey = element.closest<HTMLElement>('[data-key]')?.dataset.key;

  // GroupSkills is also rendered on the encounter sheet, whose document may
  // not support skill rolls at all.
  if (!skillKey || typeof app.document.rollSkill !== 'function') {
    return;
  }

  ui.context.menuItems = getGroupSkillRollContextOptions(app, skillKey);

  TidyHooks.tidy5eSheetsGetGroupSkillRollContextOptions(
    app.document,
    skillKey,
    ui.context.menuItems
  );
}

/**
 * Prepare an array of context entries for group skill rolls with each ability.
 * @param app         The calling application.
 * @param skillKey    The skill key that corresponds to CONFIG.DND5E.skills.
 * @returns           Context menu options.
 */
export function getGroupSkillRollContextOptions(
  app: { document: any },
  skillKey: string
): ContextMenuEntry[] {
  if (!settings.value.useContextMenu) {
    return [];
  }

  const skill = CONFIG.DND5E.skills[skillKey ?? ''];

  const skillLabel = localizeConfigLabel(skill);
  const defaultAbility = skill?.ability;

  const options: ContextMenuEntry[] = Object.entries(CONFIG.DND5E.abilities)
    .map(
      ([abilityKey, ability]) =>
        ({
          name: FoundryAdapter.localize('DND5E.SkillRoll', {
            ability: localizeConfigLabel(ability),
            skill: skillLabel,
          }),
          callback: (_target: HTMLElement, event: Event) => {
            const options = { skill: skillKey, ability: abilityKey, event };

            if (
              !FoundryAdapter.userIsGm() ||
              TidyHooks.tidy5eSheetsPrePromptGroupSkillRoll(app, options) ===
                false
            ) {
              return;
            }

            return app.document.rollSkill(options);
          },
          classes:
            defaultAbility === abilityKey ? undefined : 'color-text-lighter',
          group: defaultAbility === abilityKey ? 'primary' : 'secondary',
        }) satisfies ContextMenuEntry
    )
    .sort((a: any, b: any) => a.group.localeCompare(b.group));

  return options;
}

/**
 * CONFIG.DND5E ability/skill entries are a plain string on older dnd5e and a
 * descriptor object with `label` on newer ones. `localize` passes display
 * strings through unchanged, so either shape resolves to a readable name.
 */
function localizeConfigLabel(config: unknown): string {
  const label =
    typeof config === 'string' ? config : ((config as any)?.label ?? '');
  return typeof label === 'string' ? FoundryAdapter.localize(label) : '';
}
