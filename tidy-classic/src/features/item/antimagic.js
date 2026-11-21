// This describes the sheet presentation. Activity use and effect suppression belong to dnd5e.
export function isAntimagicItem(item) {
  if (!item) return false;
  const { system, type } = item;
  return type === 'spell' ||
    (type === 'consumable' && system.type?.value === 'scroll') ||
    !!system.properties?.has?.('mgc') ||
    !!system.activities?.some?.(activity => activity.visibility?.requireMagic);
}
