import type { Activity5e } from 'src/foundry/dnd5e.types';
import {
  localizedActivationTypeLabel,
  resolveLocalizationKey,
} from 'src/foundry/dnd5e-compat';
import { TidyHooks } from 'src/foundry/TidyHooks';
import type { Item5e } from 'src/types/item.types';
import type {
  ActivityItemContext,
  Actor5e,
  CharacterItemContext,
  LinkedUses,
  NpcItemContext,
} from 'src/types/types';

export class Activities {
  /**
   * Whether an activity belongs in a list at all (ported from tidy5e-sheet 14).
   *
   * dnd5e 6.0 separates display (`isHidden`: rider, hidden item, visibility rules for
   * attunement / magic / identification / level) from usability (`canUse`, which is
   * `item.canUse && !isHidden`). Filtering on `canUse` therefore also dropped activities
   * the system itself still shows — a facility order already in progress or disabled by
   * an attack, anything on an actor inside a compendium. Pre-6.0 activities have no
   * `isHidden`, so they keep the old `canUse` test.
   */
  static isActivityVisible(activity: Activity5e): boolean {
    return 'isHidden' in activity ? !activity.isHidden : activity.canUse;
  }

  static isConfigurable(activity: Activity5e) {
    return activity.canConfigure;
  }

  static getVisibleActivities(
    item: Item5e,
    activities: Activity5e[],
    forItemSheet: boolean = false
  ): Activity5e[] {
    // To allow the array to be completely swapped during hook calls, contain within an object.
    const visibleActivities = {
      activities:
        activities?.filter(
          (a: Activity5e) =>
            !item.getFlag('dnd5e', 'riders.activity')?.includes(a.id) &&
            Activities.isActivityVisible(a)
        ) ?? [],
    };

    if (!forItemSheet) {
      TidyHooks.tidy5eSheetsGetActivitiesForPlay(item, visibleActivities);
    }

    return visibleActivities.activities;
  }

  static activationMap: Record<string, string> = {
    action: 'DND5E.ActionAbbr',
    bonus: 'DND5E.BonusActionAbbr',
    reaction: 'DND5E.ReactionAbbr',
    minute: 'DND5E.TimeMinuteAbbr',
    hour: 'DND5E.TimeHourAbbr',
    day: 'DND5E.TimeDayAbbr',
  };

  static getActivityItemContext(activity: Activity5e): ActivityItemContext {
    // To Hit
    const toHit = parseInt(activity.labels.modifier);

    // Activation
    const activationAbbr =
      Activities.activationMap[activity.activation?.type || ''];

    // Limited Uses / Recharge
    const hasRecharge =
      activity.uses?.max && activity.uses.recovery?.[0]?.period === 'recharge';
    const isOnCooldown = hasRecharge && activity.uses.value < 1;

    return {
      id: activity.id,
      activity,
      hasRecharge,
      hasLimitedUses: !!activity.uses?.max,
      isOnCooldown,
      activation: activationAbbr
        ? `${activity.activation.value ?? ''}${game.i18n.localize(
            resolveLocalizationKey(activationAbbr)
          )}`
        : (localizedActivationTypeLabel(
            activity.activation?.type,
            typeof activity.activation?.value === 'number'
              ? activity.activation.value
              : undefined
          ) ?? activity.labels.activation),
      save: activity.save
        ? {
            ability: activity.save.ability?.size
              ? activity.save.ability.size === 1
                ? CONFIG.DND5E.abilities[activity.save.ability.first()]
                    ?.abbreviation
                : game.i18n.localize('DND5E.AbbreviationDC')
              : null,
          }
        : null,
      toHit: isNaN(toHit) ? null : toHit,
    };
  }

  static getLinkedUses(item: Item5e): LinkedUses | undefined {
    const linkedActivity = item.system.linkedActivity;

    if (linkedActivity) {
      return linkedActivity.consumption?.targets.find(
        (t: any) => t.type === 'activityUses'
      )
        ? {
            ...linkedActivity.uses,
            valueProp: 'uses.value',
            spentProp: 'uses.spent',
            maxProp: 'uses.max',
            doc: linkedActivity,
          }
        : linkedActivity.consumption?.targets.find(
            (t: any) => t.type === 'itemUses'
          )
        ? {
            ...linkedActivity.item.system.uses,
            valueProp: 'system.uses.value',
            spentProp: 'system.uses.spent',
            maxProp: 'system.uses.max',
            doc: linkedActivity.item,
          }
        : undefined;
    }
  }
}
