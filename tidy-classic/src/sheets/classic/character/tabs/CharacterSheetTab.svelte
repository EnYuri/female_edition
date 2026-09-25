<script lang="ts">
  import { getCharacterSheetContext } from 'src/sheets/sheet-context.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { localizedActivationLabel } from 'src/foundry/dnd5e-compat';
  import ItemEditControl from 'src/components/item-list/controls/ItemEditControl.svelte';
  import ItemDeleteControl from 'src/components/item-list/controls/ItemDeleteControl.svelte';
  import ItemTable from 'src/components/item-list/v1/ItemTable.svelte';
  import ItemTableHeaderRow from 'src/components/item-list/v1/ItemTableHeaderRow.svelte';
  import ItemTableRow from 'src/components/item-list/v1/ItemTableRow.svelte';
  import ItemTableFooter from 'src/components/item-list/ItemTableFooter.svelte';
  import ItemTableCell from 'src/components/item-list/v1/ItemTableCell.svelte';
  import ItemTableColumn from 'src/components/item-list/v1/ItemTableColumn.svelte';
  import ItemUseButton from 'src/components/item-list/ItemUseButton.svelte';
  import { CONSTANTS } from 'src/constants';
  import ItemName from 'src/components/item-list/ItemName.svelte';
  import ItemUses from 'src/components/item-list/ItemUses.svelte';
  import InlineFavoriteIcon from 'src/components/item-list/InlineFavoriteIcon.svelte';
  import ItemFavoriteControl from 'src/components/item-list/controls/ItemFavoriteControl.svelte';
  import { getContext, type ComponentProps } from 'svelte';
  import Notice from 'src/components/notice/Notice.svelte';
  import RechargeControl from 'src/components/item-list/controls/RechargeControl.svelte';
  import ActionFilterOverrideControl from 'src/components/item-list/controls/ActionFilterOverrideControl.svelte';
  import { declareLocation } from 'src/types/location-awareness.types';
  import UtilityToolbar from 'src/components/utility-bar/UtilityToolbar.svelte';
  import SheetPins from 'src/sheets/classic/actor/parts/SheetPins.svelte';
  import Search from 'src/components/utility-bar/Search.svelte';
  import UtilityToolbarCommand from 'src/components/utility-bar/UtilityToolbarCommand.svelte';
  import FilterMenu from 'src/components/filter/FilterButton.svelte';
  import PinnedFilterToggles from 'src/components/filter/PinnedFilterToggles.svelte';
  import { ItemFilterRuntime } from 'src/runtime/item/ItemFilterRuntime.svelte';
  import type { Item5e } from 'src/types/item.types';
  import type {
    RenderableClassicControl,
    SheetTabClassicSection,
  } from 'src/types/types';
  import ClassicControls from 'src/sheets/classic/shared/ClassicControls.svelte';
  import { TidyFlags } from 'src/foundry/TidyFlags';
  import { isItemInActionList } from 'src/features/actions/actions.svelte';
  import { ItemUtils } from 'src/utils/ItemUtils';
  import { UserSheetPreferencesService } from 'src/features/user-preferences/SheetPreferencesService';
  import {
    createSearchResultsState,
    setSearchResultsContext,
  } from 'src/features/search/search.svelte';
  import { ItemVisibility } from 'src/features/sections/ItemVisibility';
  import InventoryList from 'src/sheets/classic/actor/InventoryList.svelte';
  import SpellbookList from 'src/components/spellbook/SpellbookList.svelte';
  import { SheetSections } from 'src/features/sections/SheetSections';

  let context = $derived(getCharacterSheetContext());

  let tabId = getContext<string>(CONSTANTS.SVELTE_CONTEXT.TAB_ID);

  let showSheetPins = $derived(
    UserSheetPreferencesService.getDocumentTypeTabPreference(
      context.document.type,
      tabId,
      'showSheetPins',
    ) ?? true,
  );

  const localize = FoundryAdapter.localize;

  const searchResults = createSearchResultsState();
  setSearchResultsContext(searchResults);

  let searchCriteria: string = $state('');

  declareLocation('sheet');

  let controls: RenderableClassicControl<{ item: Item5e }>[] = $derived.by(
    () => {
      let result: RenderableClassicControl<{ item: Item5e }>[] = [
        {
          component: ItemFavoriteControl,
          props: ({ item }) =>
            ({
              item,
              favorited: FoundryAdapter.isItemFavorited(item),
            }) satisfies ComponentProps<typeof ItemFavoriteControl>,
        },
        {
          component: ItemEditControl,
          props: ({ item }) =>
            ({ item }) satisfies ComponentProps<typeof ItemEditControl>,
        },
      ];

      if (context.unlocked) {
        result.push({
          component: ItemDeleteControl,
          props: ({ item }) =>
            ({ item }) satisfies ComponentProps<typeof ItemDeleteControl>,
        });
      }

      if (context.useActionsFeature) {
        result.push({
          component: ActionFilterOverrideControl,
          props: ({ item }) =>
            ({
              item,
              flagValue: TidyFlags.actionFilterOverride.get(item),
              active: isItemInActionList(item),
            }) satisfies ComponentProps<typeof ActionFilterOverrideControl>,
        });
      }

      return result;
    },
  );

  let classicControlsIconWidth = 1.25;

  let sections = $derived.by(() => {
    const sectionConfig = TidyFlags.sectionConfig.get(context.actor)?.[tabId];
    const sorted = SheetSections.sortKeyedSections(
      context.sheetTabSections,
      sectionConfig,
    );
    for (const section of sorted) {
      section.show = sectionConfig?.[section.key]?.show !== false;
    }
    return sorted;
  });

  let noSections = $derived(
    sections.every((section) =>
      section.type === CONSTANTS.SECTION_TYPE_CUSTOM
        ? (section as any).actions?.length === 0
        : (section as any).items?.length === 0,
    ),
  );

  $effect(() => {
    searchResults.criteria = searchCriteria;
    searchResults.uuids = ItemVisibility.getItemsToShowAtDepth({
      criteria: searchCriteria,
      itemContext: context.itemContext,
      sections: sections as any[],
      tabId: tabId,
    });
  });

  let utilityBarCommands = $derived(
    context.utilities[tabId]?.utilityToolbarCommands ?? [],
  );

  let classicControlsColumnWidth = $derived(
    `${classicControlsIconWidth * controls.length}rem`,
  );

  function getSectionItems(section: SheetTabClassicSection): Item5e[] {
    return 'items' in section ? section.items : section.actions.map((a) => a.item);
  }
</script>

<UtilityToolbar>
  <Search bind:value={searchCriteria} />
  <PinnedFilterToggles
    filterGroupName={tabId}
    filters={ItemFilterRuntime.getPinnedFiltersForTab(
      context.filterPins,
      context.filterData,
      tabId,
    )}
  />
  <FilterMenu {tabId} />
  {#each utilityBarCommands as command (command.id)}
    <UtilityToolbarCommand
      title={command.title}
      iconClass={command.iconClass}
      text={command.text}
      visible={command.visible ?? true}
      onExecute={(ev) => command.execute?.(ev)}
      sections={sections as any[]}
    />
  {/each}
</UtilityToolbar>

{#if showSheetPins}
  <SheetPins />
{/if}

<div
  class="scroll-container flex-column small-gap"
  data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.ITEMS_CONTAINER}
>
  {#if noSections && !context.unlocked}
    <Notice>{localize('TIDY5E.EmptySection')}</Notice>
  {:else}
    {#each sections as section (section.key)}
      {@const sectionItems = getSectionItems(section)}
      {@const visibleItemCount = ItemVisibility.countVisibleItems(
        sectionItems,
        searchResults.uuids,
      )}

      {#if section.type === CONSTANTS.SECTION_TYPE_INVENTORY && section.show && visibleItemCount > 0}
        <InventoryList {section} />
      {:else if section.type === CONSTANTS.SECTION_TYPE_SPELLBOOK && section.show && visibleItemCount > 0}
        <SpellbookList {section} />
      {:else if section.show && ((searchCriteria.trim() === '' && context.unlocked) || visibleItemCount > 0)}
        <ItemTable
          key={section.key}
          data-custom-section={section.custom ? true : null}
          expandedOverride={searchCriteria.trim() !== ''
            ? visibleItemCount > 0
            : undefined}
        >
          {#snippet header()}
            <ItemTableHeaderRow>
              <ItemTableColumn primary={true}>
                {localize(section.label)}
                <span class="item-table-count">{visibleItemCount}</span>
              </ItemTableColumn>
              <ItemTableColumn baseWidth="3.125rem">
                {localize('DND5E.Uses')}
              </ItemTableColumn>
              <ItemTableColumn baseWidth="7.5rem">
                {localize('DND5E.Usage')}
              </ItemTableColumn>
              {#if context.editable && context.useClassicControls}
                <ItemTableColumn baseWidth={classicControlsColumnWidth} />
              {/if}
            </ItemTableHeaderRow>
          {/snippet}
          {#snippet body()}
            {#each sectionItems as item (item.id)}
              {@const ctx = context.itemContext[item.id]}
              <ItemTableRow
                {item}
                onMouseDown={(event) =>
                  FoundryAdapter.editOnMiddleClick(event, item)}
                contextMenu={{
                  type: CONSTANTS.CONTEXT_MENU_TYPE_ITEMS,
                  uuid: item.uuid,
                }}
                hidden={!searchResults.show(item.uuid)}
              >
                {#snippet children({ toggleSummary })}
                  <ItemTableCell primary={true}>
                    <ItemUseButton disabled={!context.editable} {item} />
                    <ItemName
                      onToggle={() => toggleSummary(context.actor)}
                      hasChildren={false}
                      {item}
                    >
                      <span
                        data-tidy-item-name={item.name}
                        data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.ITEM_NAME}
                        class="truncate flex-1">{item.name}</span
                      >
                    </ItemName>
                    <div class="primary-cell-extras">
                      {#if !context.useClassicControls && 'favoriteId' in ctx && !!ctx.favoriteId}
                        <InlineFavoriteIcon />
                      {/if}
                    </div>
                  </ItemTableCell>
                  <ItemTableCell baseWidth="3.125rem">
                    {#if item.isOnCooldown}
                      <RechargeControl
                        document={item}
                        field={'system.uses.spent'}
                        uses={item.system.uses}
                      />
                    {:else if item.hasRecharge}
                      {@const remaining =
                        item.system.uses.max - item.system.uses.spent}
                      {#if remaining > 1}
                        <span>{remaining}</span>
                      {/if}
                      <i
                        class="fas fa-bolt"
                        title={localize('DND5E.Charged')}
                      ></i>
                    {:else if ctx?.hasUses}
                      <ItemUses {item} />
                    {:else}
                      <span class="text-body-tertiary">&mdash;</span>
                    {/if}
                  </ItemTableCell>
                  <ItemTableCell baseWidth="7.5rem">
                    {#if ItemUtils.hasActivationType(item)}
                      {localizedActivationLabel(item)}
                    {/if}
                  </ItemTableCell>
                  {#if context.editable && context.useClassicControls}
                    <ItemTableCell baseWidth={classicControlsColumnWidth}>
                      <ClassicControls {controls} params={{ item: item }} />
                    </ItemTableCell>
                  {/if}
                {/snippet}
              </ItemTableRow>
            {/each}
            {#if context.unlocked && 'canCreate' in section && section.canCreate === true}
              <ItemTableFooter {section} actor={context.actor} isItem={true} />
            {/if}
          {/snippet}
        </ItemTable>
      {/if}
    {/each}
  {/if}
</div>
