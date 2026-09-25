<script lang="ts">
  import { UserSheetPreferencesService } from 'src/features/user-preferences/SheetPreferencesService';
  import SheetPins from 'src/sheets/classic/actor/parts/SheetPins.svelte';
  import SpellbookFooter from 'src/components/spellbook/SpellbookFooter.svelte';
  import SpellbookGrid from 'src/components/spellbook/SpellbookGrid.svelte';
  import SpellbookList from 'src/components/spellbook/SpellbookList.svelte';
  import type { ItemLayoutMode } from 'src/types/types';
  import { getContext, setContext } from 'svelte';
  import NoSpells from '../../actor/NoSpells.svelte';
  import UtilityToolbar from 'src/components/utility-bar/UtilityToolbar.svelte';
  import Search from 'src/components/utility-bar/Search.svelte';
  import UtilityToolbarCommand from 'src/components/utility-bar/UtilityToolbarCommand.svelte';
  import FilterMenu from 'src/components/filter/FilterButton.svelte';
  import PinnedFilterToggles from 'src/components/filter/PinnedFilterToggles.svelte';
  import { ItemFilterRuntime } from 'src/runtime/item/ItemFilterRuntime.svelte';
  import { TidyFlags } from 'src/foundry/TidyFlags';
  import { SheetSections } from 'src/features/sections/SheetSections';
  import { ItemVisibility } from 'src/features/sections/ItemVisibility';
  import { CONSTANTS } from 'src/constants';
  import ButtonMenu from 'src/components/button-menu/ButtonMenu.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import ButtonMenuCommand from 'src/components/button-menu/ButtonMenuCommand.svelte';
  import SpellSourceClassAssignmentsFormApplication from 'src/applications/spell-source-class-assignments/SpellSourceClassAssignmentsFormApplication.svelte';
  import {
    createSearchResultsState,
    setSearchResultsContext,
  } from 'src/features/search/search.svelte';
  import { getNpcSheetContext } from 'src/sheets/sheet-context.svelte';

  let context = $derived(getNpcSheetContext());
  let tabId = getContext<string>(CONSTANTS.SVELTE_CONTEXT.TAB_ID);
  let showSheetPins = $derived(
    UserSheetPreferencesService.getDocumentTypeTabPreference(
      context.document.type,
      tabId,
      'showSheetPins',
    ) ?? true,
  );

  setContext(CONSTANTS.SVELTE_CONTEXT.INLINE_EFFECTS_READONLY, true);

  let searchCriteria: string = $state('');

  let spellbook = $derived(
    SheetSections.configureSpellbook(context.actor, tabId, context.spellbook),
  );

  const searchResults = createSearchResultsState();
  setSearchResultsContext(searchResults);

  $effect(() => {
    searchResults.criteria = searchCriteria;
    searchResults.uuids = ItemVisibility.getItemsToShowAtDepth({
      criteria: searchCriteria,
      itemContext: context.itemContext,
      sections: spellbook,
      tabId: tabId,
    });
  });

  let layoutMode: ItemLayoutMode = $derived(
    TidyFlags.spellbookGrid.get(context.actor) ? 'grid' : 'list',
  );

  let noSpellLevels = $derived(!context.spellbook.length);

  let utilityBarCommands = $derived(
    context.utilities[tabId]?.utilityToolbarCommands ?? [],
  );

  const localize = FoundryAdapter.localize;
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
  <FilterMenu {tabId}>
    {#snippet beforeClearButton()}
      <div class="filter-option-group">
        <label class="filter-option flex-row no-gap align-items-center">
          <input
            type="checkbox"
            checked={TidyFlags.includeRitualsInCanCast.get(context.actor)}
            onchange={(ev) =>
              TidyFlags.includeRitualsInCanCast.set(
                context.actor,
                ev.currentTarget.checked,
              )}
          />
          <span
            >{localize(
              'TIDY5E.ItemFilters.Options.IncludeRitualsInCanCast',
            )}</span
          >
        </label>
      </div>
    {/snippet}
  </FilterMenu>
  <ButtonMenu
    iconClass="ra ra-fairy-wand"
    buttonStyle="transparent-inline-icon"
    position="bottom"
    anchor="right"
    title={localize('TIDY5E.Utilities.Tools')}
    menuElement="div"
  >
    <ButtonMenuCommand
      onMenuClick={() => {
        new SpellSourceClassAssignmentsFormApplication({
          document: context.actor,
        }).render({ force: true });
      }}
      iconClass="fas fa-list-check"
      disabled={!context.editable}
    >
      {localize('TIDY5E.Utilities.AssignSpellsToClasses')}
    </ButtonMenuCommand>
  </ButtonMenu>
  {#each utilityBarCommands as command (command.id)}
    <UtilityToolbarCommand
      title={command.title}
      iconClass={command.iconClass}
      text={command.text}
      visible={command.visible ?? true}
      onExecute={(ev) => command.execute?.(ev)}
      sections={spellbook}
    />
  {/each}
</UtilityToolbar>
  {#if showSheetPins}
    <SheetPins />
  {/if}

<div class="scroll-container flex-column small-gap">
  {#if noSpellLevels}
    <NoSpells editable={context.unlocked} />
  {:else}
    {#each spellbook as section (section.key)}
      {#if section.show}
        {@const visibleItemCount = ItemVisibility.countVisibleItems(
          section.items,
          searchResults.uuids,
        )}
        {#if (searchCriteria.trim() === '' && context.unlocked) || visibleItemCount > 0 || !!section.slots}
          {@const expandedOverride = searchCriteria.trim() !== ''
            ? visibleItemCount > 0
            : undefined}
          {@const unavailable =
            searchCriteria.trim() !== '' &&
            visibleItemCount === 0 &&
            !!section.slots}
          <div
            class="spellbook-section-wrapper"
            class:unavailable
          >
            {#if layoutMode === 'list'}
              <SpellbookList allowFavorites={false} {section} {expandedOverride} />
            {:else}
              <SpellbookGrid {section} {expandedOverride} />
            {/if}
          </div>
        {/if}
      {/if}
    {/each}
  {/if}
</div>
<SpellbookFooter />

<style lang="less">
  .spellbook-section-wrapper.unavailable {
    opacity: 0.5;
  }
</style>
