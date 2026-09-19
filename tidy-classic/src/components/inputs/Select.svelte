<script lang="ts">
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type {
    ContainerSheetClassicContext,
    ItemSheetContext,
  } from 'src/types/item.types';
  import type {
    CharacterSheetContext,
    NpcSheetContext,
    VehicleSheetContext,
  } from 'src/types/types';
  import { ActiveEffectsHelper } from 'src/utils/active-effect';
  import { buildDataset } from 'src/utils/data';
  import { type Snippet } from 'svelte';

  interface Props {
    value: unknown;
    tooltip?: string | null;
    field: string;
    document: any;
    id?: string | null;
    dataset?: Record<string, unknown> | null;
    title?: string | null;
    disabled?: boolean;
    blankValue?: any;
    /** Build the update payload. Defaults to `{ [field]: value }`. Needed where the
     *  running dnd5e version does not accept `field` as written — see
     *  `buildItemRarityUpdate` in src/foundry/dnd5e-compat.ts. */
    buildUpdate?: ((value: unknown) => Record<string, unknown>) | null;
    children?: Snippet;
    [key: string]: any;
  }

  let {
    value,
    tooltip = null,
    field,
    document,
    id = null,
    dataset = null,
    title = null,
    disabled = false,
    blankValue = null,
    buildUpdate = null,
    children,
    ...rest
  }: Props = $props();

  let draftValue = $state('');

  $effect(() => {
    draftValue = value?.toString() ?? '';
  });

  async function saveChange(
    event: Event & {
      currentTarget: EventTarget & HTMLSelectElement;
    },
  ) {
    const targetValue = event.currentTarget.value;
    const resolved = targetValue !== '' ? targetValue : blankValue;

    await document.update(
      buildUpdate ? buildUpdate(resolved) : { [field]: resolved }
    );
  }

  const context =
    $derived(
      getSheetContext<
        | CharacterSheetContext
        | NpcSheetContext
        | VehicleSheetContext
        | ContainerSheetClassicContext
        | ItemSheetContext
      >(),
    );

  const localize = FoundryAdapter.localize;

  let datasetAttributes = $derived(buildDataset(dataset));
  let activeEffectApplied = $derived(
    ActiveEffectsHelper.isActiveEffectAppliedToField(document, field),
  );
  let isEnchanted = $derived(
    'itemOverrides' in context &&
      context.itemOverrides instanceof Set &&
      context.itemOverrides.has(field),
  );
  let overrideTooltip = $derived(
    isEnchanted
      ? localize('DND5E.ENCHANTMENT.Warning.Override')
      : localize('DND5E.ActiveEffectOverrideWarning'),
  );
</script>

<select
  {id}
  bind:value={draftValue}
  data-tooltip={activeEffectApplied ? overrideTooltip : tooltip}
  onchange={document && saveChange}
  {title}
  {...datasetAttributes}
  disabled={disabled || activeEffectApplied}
  data-tidy-field={field}
  class={rest.class ?? ''}
>
  {@render children?.()}
</select>
