import type { ItemSummaryCommand } from 'src/api/api.types';
import { CONSTANTS } from 'src/constants';
import type { RegisteredItemSummaryCommand } from './types';
import type { Item5e } from 'src/types/item.types';

export class ItemSummaryRuntime {
  private static _itemSummaryCommands: RegisteredItemSummaryCommand[] = [
    {
      execute: (params) => params.item.displayCard(),
      label: 'DND5E.DisplayCard',
      iconClass: 'fa-solid fa-message-arrow-up-right',
    },
    {
      execute: (params) =>
        params.item.sheet?.render({
          force: true,
          mode: CONSTANTS.SHEET_MODE_PLAY,
        }),
      label: 'TIDY5E.ContextMenuActionView',
      iconClass: 'fa-solid fa-eye',
    },
  ];

  static registerItemSummaryCommands(commands: ItemSummaryCommand[]) {
    ItemSummaryRuntime._itemSummaryCommands.push(...commands);
  }

  static getItemSummaryCommands(item: Item5e): RegisteredItemSummaryCommand[] {
    return [...ItemSummaryRuntime._itemSummaryCommands].filter(
      (c) => item && (c.enabled?.({ item }) ?? true)
    );
  }
}
