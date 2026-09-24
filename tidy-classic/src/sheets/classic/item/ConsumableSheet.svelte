<script lang="ts">
  import Tabs from 'src/components/tabs/Tabs.svelte';
  import TabContents from 'src/components/tabs/TabContents.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import ItemProfilePicture from './parts/ItemProfilePicture.svelte';
  import ItemRarityInput from 'src/components/inputs/ItemRarityInput.svelte';
  import Source from '../shared/Source.svelte';
  import { CONSTANTS } from 'src/constants';
  import ItemIdentifiableName from './parts/ItemIdentifiableName.svelte';
  import ItemHeaderToggles from './parts/ItemHeaderToggles.svelte';
  import { getItemSheetContext } from 'src/sheets/sheet-context.svelte';
  
  let context = $derived(getItemSheetContext());

  let appId = $derived(context.document.id);

  let selectedTabId: string = $state('');
  const localize = FoundryAdapter.localize;
</script>

<header class="sheet-header flexrow gap">
  <ItemProfilePicture />

  <div
    class="header-details flexrow small-gap"
    data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.NAME_HEADER_ROW}
  >
    <h1
      class="charname"
      data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.NAME_CONTAINER}
    >
      <ItemIdentifiableName />
    </h1>

    <div class="item-subtitle">
      <h4 class="item-type">{context.itemType ?? ''}</h4>
      {#if context.itemStatus && context.itemStatus !== context.itemType}
        <span class="item-status">{context.itemStatus ?? ''}</span>
      {/if}
    </div>

    <ul class="summary flexrow">
      <li>{context.itemType}</li>
      <li>
        {#if context.concealDetails}
          <span>{localize('DND5E.Unidentified.Title')}</span>
        {:else}
          <ItemRarityInput item={context.item} {context} id="{appId}-rarity" />
        {/if}
      </li>
      <li class="flex-row">
        <Source
          document={context.item}
          keyPath="system.source"
          editable={context.editable && !context.concealDetails}
        />
      </li>
    </ul>
    <ItemHeaderToggles />
  </div>
</header>
<Tabs bind:selectedTabId tabs={context.tabs} sheet={context.sheet} />
<section class="tidy-sheet-body">
  <TabContents tabs={context.tabs} {selectedTabId} />
</section>
