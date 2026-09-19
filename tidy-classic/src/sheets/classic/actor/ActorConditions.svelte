<script lang="ts">
  import ItemTable from 'src/components/item-list/v1/ItemTable.svelte';
  import ItemTableColumn from 'src/components/item-list/v1/ItemTableColumn.svelte';
  import ItemTableHeaderRow from 'src/components/item-list/v1/ItemTableHeaderRow.svelte';
  import ConditionToggle from 'src/components/toggles/ConditionToggle.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import type { Dnd5eActorCondition } from 'src/foundry/foundry-and-system';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type { CharacterSheetContext, NpcSheetContext } from 'src/types/types';

  interface Props {
    conditions: Dnd5eActorCondition[];
  }

  let { conditions }: Props = $props();

  const localize = FoundryAdapter.localize;
</script>

<ItemTable key="conditions">
  {#snippet header()}
    <ItemTableHeaderRow>
      <ItemTableColumn primary={true}>
        {localize('DND5E.Conditions')}
      </ItemTableColumn>
    </ItemTableHeaderRow>
  {/snippet}
  {#snippet body()}
    <ul class="conditions-list">
      {#each conditions as condition (condition.id)}
        <li
          class="condition"
          class:active={!condition.disabled}
          data-uuid={condition.reference}
          data-condition-id={condition.id}
        >
          <ConditionToggle {condition} />
        </li>
      {/each}
    </ul>
  {/snippet}
</ItemTable>
