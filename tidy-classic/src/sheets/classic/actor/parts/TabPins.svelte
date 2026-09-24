<script lang="ts">
  import AttributeItemPin from 'src/sheets/classic/character/parts/AttributeItemPin.svelte';
  import AttributeActivityPin from 'src/sheets/classic/character/parts/AttributeActivityPin.svelte';
  import { AttributePins } from 'src/features/attribute-pins/AttributePins';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type { CharacterSheetContext } from 'src/types/types';
  import { error } from 'src/utils/logging';

  interface Props {
    tabId: string;
    searchCriteria?: string;
  }

  let { tabId, searchCriteria = '' }: Props = $props();

  let context = $derived(getSheetContext<CharacterSheetContext>());

  let visiblePins = $derived.by(() => {
    const tabPins = (context.attributePins ?? []).filter(
      (pin) => (pin.tab ?? AttributePins.DEFAULT_TAB) === tabId,
    );

    const trimmed = searchCriteria.trim().toLowerCase();

    if (trimmed === '') {
      return tabPins;
    }

    return tabPins.filter(
      (pin) =>
        pin.alias?.toLowerCase().includes(trimmed) ||
        (pin.type === 'item'
          ? FoundryAdapter.searchItem(pin.document, searchCriteria)
          : pin.document.name.toLowerCase().includes(trimmed) ||
            FoundryAdapter.searchItem(pin.document.item, searchCriteria)),
    );
  });
</script>

{#if visiblePins.length}
  <div class="attribute-pins">
    {#each visiblePins as ctx (ctx.id)}
      <svelte:boundary
        onerror={(e) =>
          error('An error occurred while rendering an attribute pin', false, e)}
      >
        {#if ctx.type === 'item'}
          <AttributeItemPin {ctx} />
        {:else if ctx.type === 'activity'}
          <AttributeActivityPin {ctx} />
        {/if}
      </svelte:boundary>
    {/each}
  </div>
{/if}
