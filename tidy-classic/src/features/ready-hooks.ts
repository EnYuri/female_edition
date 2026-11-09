import { Tidy5eSheetsApi } from 'src/api/Tidy5eSheetsApi';
import { CONSTANTS } from 'src/constants';
import { isNil } from 'src/utils/data';
import {
  buildSpellSourceClassUpdate,
  getSpellSourceClass,
  spellSourceIsSystemGrant,
} from 'src/foundry/dnd5e-compat';

export function initReadyHooks() {
  assignDroppedSpellsToClassFilter();
}

function assignDroppedSpellsToClassFilter() {
  Hooks.on('createItem', (item: any, _options: unknown, userId: string) => {
    // Only the creating client: `createItem` fires on every client, and the filter is
    // that user's own sheet state. Without this, every client with the sheet open issued
    // the update too (an observer's attempt failing on permissions), each with its own
    // filter value.
    if (userId !== game.user?.id) {
      return;
    }

    const parent = item.parent;
    const api = Tidy5eSheetsApi._getApi();

    if (!parent?.sheet?.element || !api.isTidy5eSheet(parent.sheet)) {
      return;
    }

    if (item.type !== CONSTANTS.ITEM_TYPE_SPELL) {
      return;
    }

    const filter = parent.sheet?.classSpellbookFilter;
    if (
      !isNil(filter, '') &&
      !spellSourceIsSystemGrant(item) &&
      getSpellSourceClass(item) !== filter
    ) {
      item.update(buildSpellSourceClassUpdate(item, filter));
    }
  });
}
