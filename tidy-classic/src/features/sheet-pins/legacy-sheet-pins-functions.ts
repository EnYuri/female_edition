import { CONSTANTS } from 'src/constants';
import type { Item5e } from 'src/types/item.types';
import type { Actor5e, SheetPinContext } from 'src/types/types';
import { Inventory } from '../sections/Inventory';
import { SheetSections } from '../sections/SheetSections';
import type { AnySheetPinFlagData } from 'src/foundry/TidyFlags.types';

/**
 * Compatibility layer for the pre-partition sheetPins implementation.
 * Default-partition pins (from the legacy `sheetPins` flag, or attribute pins
 * that recorded no tab) are mapped to each classic sheet's aggregate tab plus
 * the tab where the pinned document natively lives.
 */
export function legacyGetAppropriateSheetPins(
  sheetDocument: Actor5e | Item5e,
  tabId: string,
  pins: (SheetPinContext | AnySheetPinFlagData)[] | undefined
) {
  if (!pins) {
    return undefined;
  }

  switch (sheetDocument.type) {
    case CONSTANTS.SHEET_TYPE_CHARACTER: {
      return getCharacterLegacyPins(sheetDocument, tabId, pins);
    }
    case CONSTANTS.SHEET_TYPE_NPC: {
      return getNpcLegacyPins(sheetDocument, tabId, pins);
    }
    case CONSTANTS.SHEET_TYPE_VEHICLE: {
      return getVehicleLegacyPins(sheetDocument, tabId, pins);
    }
    case CONSTANTS.SHEET_TYPE_GROUP: {
      return getGroupLegacyPins(sheetDocument, tabId, pins);
    }
    case CONSTANTS.SHEET_TYPE_ENCOUNTER: {
      return getEncounterLegacyPins(sheetDocument, tabId, pins);
    }
    default: {
      return [];
    }
  }
}

function getPinnedItem(sheetDocument: any, pin: any): Item5e | undefined {
  const document = fromUuidSync(pin.id, { relative: sheetDocument });

  return document?.item ?? document;
}

function getCharacterLegacyPins(
  sheetDocument: any,
  tabId: string,
  pins: (SheetPinContext | AnySheetPinFlagData)[]
) {
  if (
    tabId === CONSTANTS.TAB_ACTOR_ACTIONS ||
    tabId === CONSTANTS.TAB_CHARACTER_SHEET
  ) {
    return pins;
  }

  return pins.filter((pin) => {
    const item = getPinnedItem(sheetDocument, pin);

    if (!item) {
      return false;
    }

    return (
      (tabId === CONSTANTS.TAB_ACTOR_INVENTORY &&
        Inventory.isItemInventoryType(item)) ||
      (tabId === CONSTANTS.TAB_ACTOR_SPELLBOOK &&
        item.type === CONSTANTS.ITEM_TYPE_SPELL) ||
      (tabId === CONSTANTS.TAB_CHARACTER_FEATURES &&
        SheetSections.showInFeatures(item))
    );
  });
}

function getNpcLegacyPins(
  sheetDocument: any,
  tabId: string,
  pins: (SheetPinContext | AnySheetPinFlagData)[]
) {
  if (tabId === CONSTANTS.TAB_ACTOR_ACTIONS) {
    return pins;
  }

  return pins.filter((pin) => {
    const item = getPinnedItem(sheetDocument, pin);

    if (!item) {
      return false;
    }

    return (
      (tabId === CONSTANTS.TAB_ACTOR_INVENTORY &&
        Inventory.isItemInventoryType(item)) ||
      (tabId === CONSTANTS.TAB_ACTOR_SPELLBOOK &&
        item.type === CONSTANTS.ITEM_TYPE_SPELL) ||
      (tabId === CONSTANTS.TAB_NPC_ABILITIES &&
        SheetSections.showInFeatures(item))
    );
  });
}

function getVehicleLegacyPins(
  sheetDocument: any,
  tabId: string,
  pins: (SheetPinContext | AnySheetPinFlagData)[]
) {
  if (tabId === CONSTANTS.TAB_VEHICLE_ATTRIBUTES) {
    return pins;
  }

  return pins.filter((pin) => {
    const item = getPinnedItem(sheetDocument, pin);

    if (!item) {
      return false;
    }

    return (
      tabId === CONSTANTS.TAB_VEHICLE_CARGO_LEGACY &&
      Inventory.isItemInventoryType(item) &&
      !item.system.isMountable
    );
  });
}

function getGroupLegacyPins(
  sheetDocument: any,
  tabId: string,
  pins: (SheetPinContext | AnySheetPinFlagData)[]
) {
  if (tabId === CONSTANTS.TAB_MEMBERS) {
    return pins;
  }

  return pins.filter((pin) => {
    const item = getPinnedItem(sheetDocument, pin);

    if (!item) {
      return false;
    }

    return (
      tabId === CONSTANTS.TAB_ACTOR_INVENTORY &&
      Inventory.isItemInventoryType(item)
    );
  });
}

function getEncounterLegacyPins(
  sheetDocument: any,
  tabId: string,
  pins: (SheetPinContext | AnySheetPinFlagData)[]
) {
  if (tabId === CONSTANTS.TAB_MEMBERS) {
    return pins;
  }

  return pins.filter((pin) => {
    const item = getPinnedItem(sheetDocument, pin);

    if (!item) {
      return false;
    }

    return (
      tabId === CONSTANTS.TAB_ACTOR_INVENTORY &&
      Inventory.isItemInventoryType(item)
    );
  });
}
