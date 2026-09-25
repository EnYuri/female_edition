import { CONSTANTS } from 'src/constants';
import { SheetPinsProvider } from 'src/features/sheet-pins/SheetPinsProvider';
import { getTabIdFromElement } from 'src/utils/element';
import type { AggregatePinTabInfo } from 'src/types/types';
import type { Activity5e } from 'src/foundry/dnd5e.types';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import type { ContextMenuEntry } from 'src/foundry/foundry.types';
import { getContextMenuOptionsQuadrone } from './tidy5e-activities-context-menu-quadrone';
import { buildRelativeUuid } from 'src/foundry/core-compat';

export function configureActivitiesContextMenu(element: HTMLElement, app: any) {
  const itemId = element.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
  const item =
    app.document.type === 'container'
      ? app.document.system.getContainedItem(itemId)
      : app.document.documentName === CONSTANTS.DOCUMENT_NAME_ITEM
      ? app.document
      : app.document.items.get(itemId);

  // Parts of ContextMenu doesn't play well with promises, so don't show menus for containers in packs
  if (!item || item instanceof Promise) {
    return;
  }

  const activityElement = element.closest<HTMLElement>('[data-activity-id]');
  const activityId = activityElement?.getAttribute('data-activity-id');

  /**
   * Activities are denoted as configurable or not.
   * Non-configurable activities include special activities like facility orders.
   */
  const configurable =
    activityElement?.matches('[data-configurable="true"]') === true;

  const activity = item.system.activities?.get(activityId);
  if (!activity) {
    return;
  }

  const isQuadroneSheet = element.closest('.quadrone');

  const menuItems = isQuadroneSheet
    ? getContextMenuOptionsQuadrone(activity, app, configurable, element)
    : getContextMenuOptions(activity, app, configurable, element);

  /**
   * A hook even that fires when the context menu for an Activity is opened.
   * @function dnd5e.getItemActivityContext
   * @memberof hookEvents
   * @param {Activity} activity             The Activity.
   * @param {HTMLElement} target            The element that menu was triggered on.
   * @param {ContextMenuEntry[]} menuItems  The context menu entries.
   */
  Hooks.callAll('dnd5e.getItemActivityContext', activity, element, menuItems);
  ui.context.menuItems = menuItems;
}

function getContextMenuOptions(
  activity: Activity5e,
  app: any,
  configurable: boolean,
  element: HTMLElement
): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];

  if (
    activity.item.isOwner &&
    !FoundryAdapter.isLockedInCompendium(activity.item)
  ) {
    entries.push(
      {
        name: 'DND5E.ContextMenuActionEdit',
        icon: '<i class="fas fa-pen-to-square fa-fw"></i>',
        callback: async () => await activity.sheet.render({ force: true }),
        condition: () => configurable,
      },
      {
        name: 'DND5E.ContextMenuActionDuplicate',
        icon: '<i class="fas fa-copy fa-fw"></i>',
        callback: async () => {
          const createData = activity.toObject();
          delete createData._id;
          await activity.item.createActivity(createData.type, createData, {
            renderSheet: false,
          });
        },
        condition: () => configurable,
      },
      {
        name: 'DND5E.ContextMenuActionDelete',
        icon: '<i class="fas fa-trash fa-fw"></i>',
        callback: async () => await activity.deleteDialog(),
        condition: () => configurable,
      }
    );
  } else {
    entries.push({
      name: 'DND5E.ContextMenuActionView',
      icon: '<i class="fas fa-eye fa-fw"></i>',
      callback: async () => await activity.sheet.render({ force: true }),
      condition: () => configurable,
    });
  }

  const pinTabId = getTabIdFromElement(element);

  entries.push({
    name: 'TIDY5E.ContextMenuActionPin',
    icon: `<i class="fa-solid fa-thumbtack"></i>`,
    callback: async () => {
      if (pinTabId) {
        await SheetPinsProvider.pin(activity, pinTabId, 'activity');
      }
    },
    condition: () =>
      app.actor &&
      activity.item.isOwner &&
      !FoundryAdapter.isLockedInCompendium(activity.item) &&
      SheetPinsProvider.isPinnable(activity, 'activity') &&
      pinTabId &&
      !SheetPinsProvider.isPinned(activity, pinTabId),
    group: 'pins',
  });

  entries.push({
    name: 'TIDY5E.ContextMenuActionUnpin',
    icon: `<i class="fa-regular fa-thumbtack"></i>`,
    callback: async () => {
      if (pinTabId) {
        await SheetPinsProvider.unpin(activity, pinTabId);
      }
    },
    condition: () =>
      activity.item.isOwner &&
      !FoundryAdapter.isLockedInCompendium(activity.item) &&
      SheetPinsProvider.isPinnable(activity, 'activity') &&
      pinTabId &&
      SheetPinsProvider.isPinned(activity, pinTabId),
    group: 'pins',
  });

  const aggregatePinTab = app.aggregatePinTab as AggregatePinTabInfo | null;

  if (aggregatePinTab) {
    entries.push({
      name: FoundryAdapter.localize('TIDY5E.ContextMenuActionPinToTab', {
        tabName: FoundryAdapter.localize(aggregatePinTab.tabName),
      }),
      icon: `<i class="fa-solid fa-thumbtack"></i>`,
      callback: async () => {
        await SheetPinsProvider.pin(
          activity,
          aggregatePinTab.tabId,
          'activity'
        );
      },
      condition: () =>
        pinTabId !== aggregatePinTab.tabId &&
        app.actor &&
        activity.item.isOwner &&
        !FoundryAdapter.isLockedInCompendium(activity.item) &&
        SheetPinsProvider.isPinnable(activity, 'activity') &&
        !SheetPinsProvider.isPinned(activity, aggregatePinTab.tabId),
      group: 'pins',
    });
  }

  if ('favorites' in (app.actor?.system ?? {})) {
    const uuid = `${buildRelativeUuid(activity.item, app.actor)}.Activity.${
      activity.id
    }`;
    const isFavorited = app.actor.system.hasFavorite(uuid);
    entries.push({
      name: isFavorited ? 'DND5E.FavoriteRemove' : 'DND5E.Favorite',
      icon: '<i class="fas fa-bookmark fa-fw"></i>',
      condition: () =>
        activity.item.isOwner &&
        !FoundryAdapter.isLockedInCompendium(activity.item),
      callback: async () => {
        if (isFavorited) {
          await app.actor.system.removeFavorite(uuid);
        } else {
          await app.actor.system.addFavorite({ type: 'activity', id: uuid });
        }
      },
      group: 'state',
    });
  }

  return entries;
}
