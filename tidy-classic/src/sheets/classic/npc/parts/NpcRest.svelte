<script lang="ts">
  import {
    getRestTypes,
    initiateActorRest,
    refreshActor,
  } from 'src/foundry/dnd5e-compat';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { settings } from 'src/settings/settings.svelte';
  import { getNpcSheetContext } from 'src/sheets/sheet-context.svelte';

  let context = $derived(getNpcSheetContext());

  let restTypeCount = $derived(Object.keys(getRestTypes()).length);
  let showRefresh = $derived(FoundryAdapter.userIsGm());
  // The horizontal expansion collides with the HP bar across the portrait's
  // bottom edge — expand upward instead: icon anchored at the corner, the
  // rest buttons stack vertically over the portrait.
  let expandedHeight = $derived(
    1.25 * (restTypeCount + (showRefresh ? 1 : 0) + 1),
  );

  const localize = FoundryAdapter.localize;
</script>

<div
  class="rest-container"
  class:has-rounded-portrait={context.useRoundedPortraitStyle}
  title={localize('TIDY5E.RestHint')}
>
  <div class="resting" style:--rest-expanded-height="{expandedHeight}rem">
    <span class="resting-icon">
      <i class="rest-icon fas fa-bed"></i>
    </span>
    {#if showRefresh}
      <button
        type="button"
        class="rest inline-icon-button"
        title={localize('TIDY5E.NPC.Refresh.label')}
        onclick={() => refreshActor(context.actor)}
        disabled={!context.editable}
        tabindex={!settings.value.useDefaultSheetHpTabbing &&
        settings.value.useAccessibleKeyboardSupport
          ? 0
          : -1}
      >
        <i class="fas fa-arrows-rotate-reverse"></i>
      </button>
    {/if}
    {#each Object.entries(getRestTypes()) as [key, rest]}
      <button
        type="button"
        class="rest {key}-rest inline-icon-button"
        title={localize(rest.label ?? key)}
        onclick={() =>
          initiateActorRest(context.actor, key, {
            chat: settings.value.showNpcRestInChat,
          })}
        disabled={!context.editable}
        tabindex={!settings.value.useDefaultSheetHpTabbing &&
        settings.value.useAccessibleKeyboardSupport
          ? 0
          : -1}
      >
        <i class={rest.icon ?? 'fas fa-bed'}></i>
      </button>
    {/each}
  </div>
</div>

<style lang="less">
  .rest-container {
    display: block;
    position: absolute;
    left: 0;
    bottom: 0;
  }

  .resting {
    width: 1.5rem;
    height: 1.25rem;
    border-radius: 0 0 0 0.3125rem;
    overflow: hidden;
    transition: height 0.3s ease;
    background: var(--t5e-icon-background);
    display: flex;
    box-shadow: 0 0 0.625rem var(--t5e-icon-shadow-color) inset;
    border: 0.0625rem solid var(--t5e-icon-outline-color);
    color: var(--t5e-icon-font-color);

    &:hover,
    &:focus-within {
      height: var(--rest-expanded-height, 3.75rem);
      flex-direction: column-reverse;
      align-items: center;
    }

    .rest {
      /* flex-basis is the vertical row height once the box expands upward;
         the width stays at the column width. */
      flex: 0 0 1.125rem;
      display: flex;
      justify-content: center;
      align-items: center;
      width: 1.5rem;
      height: 1.125rem;
      border-radius: 50%;
      cursor: pointer;
      border: none;
      color: var(--t5e-tertiary-color);
      padding: 0;
      font-size: 0.75rem;
      line-height: 1.125rem;
      font-family: var(--t5e-body-font-family);
      font-weight: 700;
      transition:
        color 0.3s ease,
        transform 0.3s ease;

      &:hover,
      &:focus-within {
        color: var(--t5e-primary-font-color);
      }
    }

    .resting-icon {
      flex: 0 0 1.25rem;
      display: flex;

      width: 1.5rem;
      height: 1.125rem;
      justify-content: center;
      align-items: center;
      border-radius: 0;
      font-size: 0.75rem;
      color: var(--t5e-primary-font-color);
    }
  }

  .rest-container.has-rounded-portrait {
    left: 0.4375rem;
    bottom: 0;

    .resting {
      border-radius: 0.3125rem 0 0 0.3125rem;
      transition: all 0.3s ease;
    }

    .resting:not(:is(:hover, :focus-within)) {
      background: transparent;
      box-shadow: none;
      border-color: transparent;
    }
  }
</style>
