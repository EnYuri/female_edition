<script lang="ts">
  import { CONSTANTS } from 'src/constants';
  import ItemProfilePicture from './parts/ItemProfilePicture.svelte';
  import ItemIdentifiableName from './parts/ItemIdentifiableName.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import ItemRarityInput from 'src/components/inputs/ItemRarityInput.svelte';
  import Source from '../shared/Source.svelte';
  import Tabs from 'src/components/tabs/Tabs.svelte';
  import TabContents from 'src/components/tabs/TabContents.svelte';
  import ItemHeaderToggles from './parts/ItemHeaderToggles.svelte';
  import { getContainerSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  
  let context = $derived(getContainerSheetClassicContext());

  let appId = $derived(context.document.id);

  let selectedTabId: string = $state('');

  const localize = FoundryAdapter.localize;
</script>

<header class="sheet-header container-header flexrow gap">
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
    </div>

    <ul class="summary flexrow">
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

<style lang="less">
</style>
