<script lang="ts">
  import Select from 'src/components/inputs/Select.svelte';
  import { CONSTANTS } from 'src/constants';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getItemSheetContext } from 'src/sheets/sheet-context.svelte';
  import type { Item5e } from 'src/types/item.types';

  let context = $derived(getItemSheetContext());

  let typesToRender = [
    CONSTANTS.ITEM_TYPE_CLASS,
    CONSTANTS.ITEM_TYPE_SUBCLASS,
    CONSTANTS.ITEM_TYPE_RACE,
    CONSTANTS.ITEM_TYPE_BACKGROUND,
  ];

  let optionGroups = $derived.by(() => {
    let groups: { title: string; options: Item5e[] }[] = [];

    const itemTypes = context.item.actor.itemTypes;

    for (let type of typesToRender) {
      const items = itemTypes[type];

      if (items?.length) {
        groups.push({
          title: localize(`TYPES.Item.${type}`),
          options: items,
        });
      }
    }

    return groups;
  });

  let originValue = $derived(
    FoundryAdapter.getAdvancementOriginId(context.item),
  );

  let id = `feature-origin-${foundry.utils.randomID()}`;

  const localize = FoundryAdapter.localize;
</script>

<div class="form-group">
  <label for={id}>{localize('TIDY5E.ItemSheet.FeatureOriginLabel')}</label>
  <Select
    {id}
    document={context.item}
    field={CONSTANTS.SYSTEM_FLAG_PATH_ADVANCEMENT_ORIGIN}
    value={originValue}
    disabled={!context.editable}
  >
    <option></option>
    {#each optionGroups as group}
      <optgroup label={group.title}>
        {#each group.options as option}
          <option value={option.id}>{option.name}</option>
        {/each}
      </optgroup>
    {/each}
  </Select>
</div>
