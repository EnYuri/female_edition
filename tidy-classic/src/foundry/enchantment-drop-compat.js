/** Check both the dnd5e 6.x structured origin and the legacy core origin. */
export function matchesEffectOrigin(effect, uuid) {
  return typeof effect.matchesOrigin === 'function'
    ? effect.matchesOrigin(uuid)
    : effect.origin === uuid;
}

/** Keep the origin of a copied enchantment on either supported dnd5e schema. */
export function prepareDroppedEnchantment(effect, effectData, activityId) {
  if (effectData.system?.origin && typeof effectData.system.origin === 'object') {
    effectData.system.origin.item ??= effect.parent?.uuid;
    if (effect.system?.isOnActivity) effectData.transfer = true;
    activityId ??= effect.parent?.system?.activities
      ?.getByType?.('enchant')
      ?.find?.((activity) => activity.effects?.some((e) => e._id === effect.id))
      ?.id;
  } else {
    effectData.origin ??= effect.parent?.uuid;
  }
  return { enchantmentProfile: effect.id, activityId };
}
