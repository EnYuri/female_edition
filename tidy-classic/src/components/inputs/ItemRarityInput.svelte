<script lang="ts">
  import Select from './Select.svelte';
  import SelectOptions from './SelectOptions.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import {
    buildItemRarityUpdate,
    getItemRarity,
  } from 'src/foundry/dnd5e-compat';
  import type { Item5e } from 'src/types/item.types';

  interface Props {
    item: Item5e;
    context: { editable: boolean; config: any };
    id: string;
  }

  let { item, context, id }: Props = $props();

  const localize = FoundryAdapter.localize;

  /** dnd5e >= 6.0 stores rarity as a `rarities` SetField; older systems use the single `rarity` string. */
  let multiRarity = $derived(
    !!item?.system?.schema?.fields?.rarities && !!customElements.get('multi-select'),
  );

  let selectedRarities = $derived.by(() => {
    const r = item?.system?.rarities;
    if (!r) {
      return [];
    }
    return r instanceof Set ? [...r] : (Array.from(r) as string[]);
  });

  let rarityOptions = $derived(
    Object.entries<string>(
      context.config.itemRarity as Record<string, string>,
    ).map(([value, label]) => {
      // The config label is pre-baked; resolve the DND5E.ItemRarity* key when a
      // translation exists so localized worlds show localized rarities.
      const key = `DND5E.ItemRarity${value[0].toUpperCase()}${value.slice(1)}`;
      return { value, label: game.i18n.has(key) ? localize(key) : label };
    }),
  );

  async function onMultiChange(event: Event) {
    const el = event.currentTarget as HTMLElement & { value: string[] };
    await item.update({ 'system.rarities': el.value });
  }
</script>

{#if multiRarity}
  <multi-select
    {id}
    name="system.rarities"
    class="item-rarity"
    disabled={!context.editable}
    onchange={onMultiChange}
  >
    {#each rarityOptions as option}
      <option value={option.value} selected={selectedRarities.includes(option.value)}
        >{option.label}</option
      >
    {/each}
  </multi-select>
{:else}
  <Select
    {id}
    document={item}
    field="system.rarity"
    buildUpdate={(rarity) => buildItemRarityUpdate(item, rarity)}
    class="item-rarity"
    value={getItemRarity(item)}
    disabled={!context.editable}
    blankValue=""
  >
    <SelectOptions
      data={context.config.itemRarity}
      blank={localize('DND5E.Rarity')}
    />
  </Select>
{/if}
