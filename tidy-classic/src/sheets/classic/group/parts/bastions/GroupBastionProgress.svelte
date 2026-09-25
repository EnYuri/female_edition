<script lang="ts">
  import Dnd5eIcon from 'src/components/icon/Dnd5eIcon.svelte';
  import { getTidyFacilityIcon } from 'src/features/facility/facility';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import type { Item5e } from 'src/types/item.types';

  interface Props {
    progress: {
      value: number;
      max: number;
      pct: number;
      order: string;
    };
    craft?: Item5e | null;
    /** Present when the row can identify a member-owned facility. */
    memberUuid?: string;
    facilityId?: string;
  }

  let { progress, craft = null, memberUuid, facilityId }: Props = $props();

  let context = $derived(getGroupSheetClassicContext());

  const localize = FoundryAdapter.localize;

  let icon = $derived(getTidyFacilityIcon(progress.order));

  let orderLabel = $derived(
    CONFIG.DND5E.facilities.orders[progress.order]?.label ?? progress.order,
  );

  // Nudging an order along is a GM correction, so it stays out of the way
  // until the sheet is unlocked. Facilities without an order have nothing to
  // step. The sheet re-checks all of this before it writes.
  let canAdjustProgress = $derived(
    FoundryAdapter.userIsGm() &&
      context.unlocked &&
      progress.max > 0 &&
      !!memberUuid &&
      !!facilityId,
  );

  function adjust(toAdjust: number) {
    context.actor.sheet.adjustMemberFacilityProgress({
      memberUuid,
      facilityId,
      toAdjust,
    });
  }

  function editCraftingItem() {
    craft?.sheet.render(true);
  }
</script>

{#snippet meter()}
  <div
    class="facility-progress-meter"
    role="meter"
    aria-valuemin="0"
    aria-valuenow={progress.pct}
    aria-valuetext={progress.value?.toString()}
    aria-valuemax={progress.max}
    style="--bar-percentage: {progress.pct}%"
    data-tooltip={localize('DND5E.TimeDay')}
  >
    <div class="label">
      <span class="order">
        {#if icon?.type === 'fa-icon-class'}
          <i class={icon.className}></i>
        {:else if icon?.type === 'dnd5e-icon'}
          <Dnd5eIcon src={icon.src}></Dnd5eIcon>
        {/if}
        <span class="progress-meter-label truncate">
          {#if craft}
            {localize('TIDY5E.Facilities.Progress.OrderAndCraftLabel', {
              orderName: orderLabel,
              craftingItemName: craft.name,
            })}
          {:else}
            {orderLabel}
          {/if}
        </span>
      </span>
      <span class="counter">
        <span class="value">{progress.value}</span> &sol;
        <span class="max">{progress.max}</span>
      </span>
    </div>
  </div>
{/snippet}

{#if progress.order}
  <div class="craft-and-meter">
    {#if craft}
      <a
        onclick={editCraftingItem}
        data-info-card={'item'}
        data-info-card-entity-uuid={craft.uuid}
      >
        <img
          class="crafting-item"
          data-uuid={craft.uuid}
          src={craft.img}
          alt={craft.name}
        />
      </a>
    {/if}

    {#if canAdjustProgress}
      <div class="facility-progress-adjust">
        <a
          class={['command decrementer', { disabled: progress.value <= 0 }]}
          role="button"
          tabindex={0}
          onclick={() => adjust(-1)}
          onkeydown={(ev) => ev.key === 'Enter' && adjust(-1)}
          aria-label={localize('DND5E.FACILITY.Progress')}
        >
          <i class="fa-solid fa-minus"></i>
        </a>

        {@render meter()}

        <a
          class={[
            'command incrementer',
            { disabled: progress.value >= progress.max },
          ]}
          role="button"
          tabindex={0}
          onclick={() => adjust(1)}
          onkeydown={(ev) => ev.key === 'Enter' && adjust(1)}
          aria-label={localize('DND5E.FACILITY.Progress')}
        >
          <i class="fa-solid fa-plus"></i>
        </a>
      </div>
    {:else}
      {@render meter()}
    {/if}
  </div>
{/if}

<style lang="less">
  .craft-and-meter {
    display: flex;
    gap: 0.125rem;
    align-items: center;
    flex: 1;
    min-width: 0;

    :global(.facility-progress-meter) {
      flex: 1;
    }

    .crafting-item {
      --img-size: 1.5rem;
      width: var(--img-size);
      height: var(--img-size);
      margin-inline-end: 0.125rem;
      border-radius: 0.1875rem;
    }

    .facility-progress-adjust {
      display: flex;
      align-items: center;
      gap: 0.125rem;
      flex: 1;

      .command {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.25rem;
        color: var(--t5e-tertiary-color);
        transition: color 0.3s ease;

        &:hover {
          color: var(--t5e-primary-font-color);
        }

        &.disabled {
          opacity: 0.4;
          pointer-events: none;
        }
      }
    }
  }
</style>
