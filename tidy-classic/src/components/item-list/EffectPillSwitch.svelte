<script lang="ts">
  import FieldToggle from 'src/components/toggles/FieldToggle.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import type { ActiveEffect5e } from 'src/types/types';

  interface Props {
    effect: ActiveEffect5e;
    categoryLabel: string;
    enabled: boolean;
    disabled?: boolean;
    /** Extra context about this effect (e.g. why it's unavailable). */
    notes?: string[];
  }

  let {
    effect,
    categoryLabel,
    enabled,
    disabled = false,
    notes = [],
  }: Props = $props();

  const localize = FoundryAdapter.localize;

  let toggleTitle = $derived(
    localize(
      enabled
        ? 'DND5E.EFFECT.Action.DisableEffect'
        : 'DND5E.EFFECT.Action.EnableEffect',
    ),
  );

  let tooltip = $derived(
    [...notes, ...(disabled ? [] : [toggleTitle])].join('<br>'),
  );

  // `||` rather than `??`, so that a blank image falls back also
  let img = $derived(effect.img || effect.icon);

  // Remember the source that failed rather than a boolean, so that changing the
  // effect's image later gets a fresh attempt at loading
  let failedImg = $state<string | undefined>(undefined);

  let showFallbackIcon = $derived(!img || failedImg === img);
</script>

{#snippet contents()}
  {#if showFallbackIcon}
    <i class="fas fa-bolt effect-pill-image"></i>
  {:else}
    <img
      class="effect-pill-image"
      src={img}
      alt={effect.name ?? ''}
      onerror={() => (failedImg = img)}
    />
  {/if}
  <span class="truncate">
    {effect.name}
  </span>
  <span class="effect-pill-category">
    ({localize(categoryLabel)})
  </span>
{/snippet}

{#if disabled}
  <span class="tag effect-pill disabled" data-tooltip-html={tooltip}>
    {@render contents()}
  </span>
{:else}
  <label
    class="tag effect-pill effect-pill-switch interactive"
    data-tooltip-html={tooltip}
  >
    <span class="effect-pill-contents">
      {@render contents()}
    </span>
    <FieldToggle
      checked={enabled}
      onchange={(ev) => effect.update({ disabled: !ev.currentTarget.checked })}
    />
  </label>
{/if}

<style lang="less">
  .effect-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;

    .effect-pill-image {
      width: 1rem;
      height: 1rem;
      border-radius: 0.1875rem;
      object-fit: cover;
      align-self: center;
    }

    .effect-pill-category {
      color: var(--t5e-tertiary-color);
    }
  }

  .effect-pill-switch {
    cursor: pointer;

    .effect-pill-contents {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      min-width: 0;
    }
  }
</style>
