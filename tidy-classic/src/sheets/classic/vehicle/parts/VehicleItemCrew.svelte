<script lang="ts">
  import { CONSTANTS } from 'src/constants';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import {
    prepareCrewAssignments,
    assignCrewMember,
    replaceCrewMember,
    unassignCrewMember,
    type VehicleItemCrewSlot,
  } from 'src/features/vehicle/VehicleCrew';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type { Item5e } from 'src/types/item.types';
  import { error } from 'src/utils/logging';

  interface Props {
    item: Item5e;
  }

  let { item }: Props = $props();

  let context = $derived(getSheetContext<{ editable: boolean }>());

  const localize = FoundryAdapter.localize;

  const crewLabel = $derived(localize('DND5E.VEHICLE.Crew.Label'));

  let slots: VehicleItemCrewSlot[] = $state([]);

  $effect(() => {
    // Track crew changes so slots refresh with the item.
    const crew = item.system.crew?.value;
    const max = item.system.crew?.max;
    void crew;
    void max;
    prepareCrewAssignments(item).then((result) => (slots = result));
  });

  async function browseForActor(replaceUuid?: string) {
    try {
      const uuid = await (dnd5e as any).applications.CompendiumBrowser.selectOne(
        {
          filters: {
            locked: {
              documentClass: 'Actor',
              types: new Set(['npc']),
            },
          },
          tab: 'monsters',
        },
      );

      if (!uuid) {
        return;
      }

      if (replaceUuid) {
        await replaceCrewMember(item, replaceUuid, uuid);
      } else {
        await assignCrewMember(item, uuid);
      }
    } catch (e) {
      error('Failed to assign a crew member', true, e);
    }
  }
</script>

{#if slots.length}
  <div class="vehicle-item-crew" data-tidy-sheet-part="vehicle-item-crew">
    <span class="vehicle-item-crew-label">{crewLabel}</span>
    <ul class="unlist flex-row extra-small-gap flex-wrap">
      {#each slots as slot, index (slot.uuid ?? `empty-${index}`)}
        <li
          class={['crew-slot', { broken: slot.brokenLink, empty: !slot.actor && !slot.brokenLink }]}
        >
          {#if slot.brokenLink}
            <button
              type="button"
              class="crew-slot-button"
              title={localize('TIDY5E.BrokenLink')}
              onclick={() => context.editable && browseForActor(slot.uuid)}
            >
              <i class="fas fa-link-slash"></i>
            </button>
          {:else if slot.actor}
            <button
              type="button"
              class="crew-slot-button crew-member"
              title={slot.actor.name}
              onclick={() => slot.actor.sheet.render({ force: true })}
            >
              <img src={slot.actor.img} alt={slot.actor.name} />
            </button>
          {:else}
            <button
              type="button"
              class="crew-slot-button empty-slot"
              title={localize('TIDY5E.AddSpecific', { name: crewLabel })}
              disabled={!context.editable}
              onclick={() => browseForActor()}
            >
              <i class="fas fa-plus"></i>
            </button>
          {/if}
          {#if context.editable && (slot.actor || slot.brokenLink)}
            <button
              type="button"
              class="crew-slot-unassign"
              title={localize('TIDY5E.ContextMenuActionUnassign')}
              onclick={() => unassignCrewMember(item, slot.uuid)}
            >
              <i class="fas fa-xmark"></i>
            </button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}

<style lang="less">
  .vehicle-item-crew {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding-block-start: 0.25rem;

    .vehicle-item-crew-label {
      color: var(--t5e-tertiary-color);
      font-size: 0.75rem;
    }

    .crew-slot {
      display: flex;
      align-items: center;
      gap: 0.125rem;
    }

    .crew-slot-button {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 1.625rem;
      height: 1.625rem;
      padding: 0;
      border-radius: 0.25rem;
      border: 0.0625rem dashed var(--t5e-separator-color);
      background: var(--t5e-faintest-color);
      color: var(--t5e-secondary-color);
      line-height: 1;

      img {
        width: 1.5rem;
        height: 1.5rem;
        border-radius: 0.1875rem;
        border: none;
      }

      &.crew-member {
        border-style: solid;
      }

      &.broken {
        border-color: var(--t5e-warning-accent-color, #994040);
        color: var(--t5e-warning-accent-color, #994040);
      }
    }

    .crew-slot-unassign {
      display: flex;
      padding: 0;
      border: none;
      background: none;
      color: var(--t5e-tertiary-color);
      font-size: 0.625rem;

      &:hover {
        color: var(--t5e-warning-accent-color, #994040);
      }
    }
  }
</style>
