<script lang="ts">
  import { type Snippet } from 'svelte';
  import type { HTMLSelectAttributes } from 'svelte/elements';

  type Props = {
    value: unknown;
    disabledValue?: unknown;
    field: string;
    document: any;
    blankValue?: any;
    /** Build the update payload. Defaults to `{ [field]: value }`. Needed where the
     *  running dnd5e version does not accept `field` as written — see
     *  `buildItemRarityUpdate` in src/foundry/dnd5e-compat.ts. */
    buildUpdate?: ((value: unknown) => Record<string, unknown>) | null;
    children?: Snippet;
  } & HTMLSelectAttributes;

  let {
    value,
    disabledValue,
    field,
    document,
    blankValue = null,
    buildUpdate = null,
    children,
    ...rest
  }: Props = $props();

  let draftValue = $state('');

  $effect(() => {
    draftValue = rest.disabled
      ? (disabledValue ?? value?.toString() ?? '')
      : (value?.toString() ?? '');
  });

  async function saveChange(
    event: Event & {
      currentTarget: EventTarget & HTMLSelectElement;
    },
  ) {
    if (rest.name) {
      return;
    }

    const targetValue = event.currentTarget.value;
    const resolved = targetValue !== '' ? targetValue : blankValue;

    await document.update(
      buildUpdate ? buildUpdate(resolved) : { [field]: resolved }
    );
  }
</script>

<select
  bind:value={draftValue}
  onchange={document && saveChange}
  {...rest}
  data-tidy-field={field}
>
  {@render children?.()}
</select>
