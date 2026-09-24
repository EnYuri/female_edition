import type { ActiveEffect5e } from 'src/types/types';
import type { Item5e } from 'src/types/item.types';
import { isNil } from './data';
import { debug, error } from './logging';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import { getEffectChangeTypeLabel } from 'src/foundry/core-compat';

/**
 * Labels for effect category types.
 */
const EFFECT_CATEGORY_TYPE_LABEL_KEYS: Record<string, string> = {
  temporary: 'DND5E.EFFECT.Status.Temporary',
  passive: 'DND5E.EFFECT.Status.Passive',
  inactive: 'DND5E.EFFECT.Status.Inactive',
  suppressed: 'DND5E.EFFECT.Status.Unavailable',
};

export class ActiveEffectsHelper {
  /**
   * Get the short-form label for an effect category, e.g. "Passive" for the
   * "Passive Effects" category. Falls back to the category's own label for any
   * category the system adds later.
   */
  static getEffectCategoryTypeLabel(category: {
    type: string;
    label: string;
  }): string {
    return EFFECT_CATEGORY_TYPE_LABEL_KEYS[category.type] ?? category.label;
  }

  /**
   * Map each rider effect ID on an item to the names of the enchantment effects
   * that apply it so that we can show tooltips.
   */
  static getRiderEffectParentNames(item: Item5e): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    const enchantmentEffects =
      item.system?.activities
        ?.getByType?.('enchant')
        ?.flatMap((activity: any) => activity.effects) ?? [];

    for (const enchantmentEffect of enchantmentEffects) {
      const parentName = item.effects.get(enchantmentEffect._id)?.name;

      if (!parentName) {
        continue;
      }

      for (const riderId of enchantmentEffect.riders?.effect ?? []) {
        (result[riderId] ??= []).push(parentName);
      }
    }

    return result;
  }

  static isActiveEffectAppliedToField(document: any, field: string) {
    try {
      return (
        document?.overrides &&
        !isNil(field) &&
        !!foundry.utils.getProperty(document.overrides, field)
      );
    } catch (e) {
      error(
        'An error occurred while checking if a field has an active effect applied',
        false,
        e
      );
      debug('Active effect error troubleshooting info', { document, field });
      return false;
    }
  }

  static getActiveEffectPills(activeEffect: ActiveEffect5e) {
    let result = [];

    if (activeEffect.disabled) {
      result.push('EFFECT.Disabled');
    }

    if (activeEffect.transfer) {
      result.push('EFFECT.Transfer');
    }

    if (activeEffect.isSuppressed) {
      result.push('DND5E.Suppressed');
    }

    Array.from<string>(activeEffect.statuses)
      .map(
        (x: string) => CONFIG.statusEffects.find((y) => y.id === x)?.name ?? x
      )
      .forEach((e) => {
        result.push(e);
      });

    return result;
  }

  static findMode(
    change: { type?: string; mode?: number },
    fallback = '—'
  ) {
    const label = getEffectChangeTypeLabel(change);
    return label ? FoundryAdapter.localize(label) : fallback;
  }
}
