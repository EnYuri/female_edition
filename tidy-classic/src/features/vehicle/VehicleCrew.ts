import { CONSTANTS } from 'src/constants';
import type { Item5e } from 'src/types/item.types';

export type VehicleItemCrewSlot = {
  actor?: any;
  uuid?: string;
  /** The slot's stored UUID cannot be resolved to an actor document. */
  brokenLink: boolean;
};

/**
 * Prepare an item's crew slots, one per point of crew capacity, plus any extra
 * assigned slots. Unresolvable UUIDs surface as broken-link slots so they can
 * be replaced or removed.
 */
export async function prepareCrewAssignments(
  item: Item5e,
): Promise<VehicleItemCrewSlot[]> {
  const assigned: string[] = item.system.crew?.value ?? [];
  const slots = Math.max(item.system.crew?.max ?? 0, assigned.length);

  return Promise.all(
    Array.fromRange(slots).map(async (index: number) => {
      const uuid = assigned[index];
      const actor = uuid ? await fromUuid(uuid) : undefined;
      return {
        actor: actor ?? undefined,
        uuid,
        brokenLink: !!uuid && !actor,
      };
    }),
  );
}

/**
 * Assign an actor to an item, respecting its crew capacity. When the item
 * belongs to a vehicle, also add to the vehicle crew.
 */
export async function assignCrewMember(item: Item5e, actorUuid: string) {
  const crew = item.system.crew;

  if (!crew) {
    return;
  }

  const assigned: string[] = [...(crew.value ?? [])];

  if (assigned.includes(actorUuid) || assigned.length >= (crew.max ?? 0)) {
    return;
  }

  assigned.push(actorUuid);

  return await updateCrew(item, assigned, actorUuid);
}

/**
 * Replace an item's crew member in the same slot; used for broken links.
 */
export async function replaceCrewMember(
  item: Item5e,
  previousUuid: string,
  actorUuid: string,
) {
  const assigned: string[] = [...(item.system.crew?.value ?? [])];
  const index = assigned.indexOf(previousUuid);

  if (index === -1) {
    return await assignCrewMember(item, actorUuid);
  }

  if (assigned.includes(actorUuid)) {
    assigned.splice(index, 1);
  } else {
    assigned[index] = actorUuid;
  }

  return await updateCrew(item, assigned, actorUuid);
}

/**
 * Update an item's crew. When the item belongs to a vehicle, also add to
 * the vehicle crew.
 */
async function updateCrew(item: Item5e, assigned: string[], actorUuid: string) {
  const vehicle =
    item.actor?.type === CONSTANTS.SHEET_TYPE_VEHICLE ? item.actor : undefined;

  if (!vehicle) {
    return await item.update({ 'system.crew.value': assigned });
  }

  const itemUpdates = { _id: item.id };
  foundry.utils.setProperty(itemUpdates, 'system.crew.value', assigned);

  const actorUpdates: Record<string, unknown> = { items: [itemUpdates] };

  // An actor manning a station is part of the vehicle's crew.
  const roster: string[] = vehicle.system.crew?.value ?? [];
  if (!roster.includes(actorUuid)) {
    Object.assign(
      actorUpdates,
      vehicle.system.getCrewUpdates('crew', actorUuid, '+1'),
    );
  }

  return await vehicle.update(actorUpdates);
}

/**
 * Remove an actor from an item's crew without updating vehicle crew.
 */
export async function unassignCrewMember(item: Item5e, memberUuid: string) {
  const assigned: string[] = [...(item.system.crew?.value ?? [])];

  const index = assigned.indexOf(memberUuid);

  if (index === -1) {
    return;
  }

  assigned.splice(index, 1);

  return await item.update({ 'system.crew.value': assigned });
}
