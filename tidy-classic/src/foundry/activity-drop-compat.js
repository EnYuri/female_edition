/** Resolve either UUID drag data or inline activity data across dnd5e versions. */
export async function resolveDroppedActivity(transfer, Activity, fromUuid) {
  if (typeof Activity?.fromDropData === 'function') {
    return Activity.fromDropData(transfer);
  }
  return transfer?.uuid ? fromUuid(transfer.uuid) : null;
}

/** Reject types that are disabled or incompatible with the target item. */
export function canCopyActivity(config, item) {
  if (!config || config.configurable === false) return false;
  const available = config.documentClass?.availableForItem;
  return typeof available !== 'function' || available.call(config.documentClass, item);
}
