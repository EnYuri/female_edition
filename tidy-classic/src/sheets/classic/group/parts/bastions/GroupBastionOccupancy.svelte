<script lang="ts">
  import { CONSTANTS } from 'src/constants';
  import { FacilityOccupantSlotLabelsMap } from 'src/features/facility/facility';
  import { dropzoneClass } from 'src/features/drag-and-drop/drag-and-drop';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import type { FacilityOccupancyContext } from 'src/types/types';
  import type OccupantSummaryTooltip from 'src/tooltips/OccupantSummaryTooltip.svelte';
  import { getContext } from 'svelte';

  interface Props {
    occupancy: FacilityOccupancyContext;
    memberUuid: string;
    /** Present on facility rows; absent on member headers, which prompt instead. */
    facilityId?: string;
  }

  let { occupancy, memberUuid, facilityId }: Props = $props();

  const localize = FoundryAdapter.localize;

  let context = $derived(getGroupSheetClassicContext());

  // Share a single tooltip instance across all cells
  const getOccupantSummaryTooltip = getContext<
    () => OccupantSummaryTooltip | undefined
  >(CONSTANTS.SVELTE_CONTEXT.OCCUPANT_SUMMARY_TOOLTIP);

  // A full facility has nowhere to put another occupant. The sheet re-checks
  // ownership before it writes anything.
  let canAddOccupant = $derived(
    context.editable && occupancy.occupants.length < occupancy.max,
  );

  function showOccupantTooltip(
    ev: Event & { currentTarget: EventTarget & HTMLElement },
  ) {
    getOccupantSummaryTooltip?.()?.tryShow(
      ev as MouseEvent & { currentTarget: EventTarget & HTMLElement },
      occupancy.occupants,
      localize(FacilityOccupantSlotLabelsMap[occupancy.slot]),
    );
  }

  function addOccupant(ev: Event) {
    if (!canAddOccupant) {
      return;
    }

    context.actor.sheet.addMemberFacilityOccupant(
      memberUuid,
      occupancy.slot,
      ev,
      facilityId,
    );
  }
</script>

{#if occupancy.max > 0}
  {#if canAddOccupant}
    <!-- A real button so header-row toggle handlers recognize it as interactable. -->
    <button
      type="button"
      class={['unbutton bastion-occupancy interactive']}
      data-occupant-slot={occupancy.slot}
      data-member-uuid={memberUuid}
      onclick={addOccupant}
      onmouseover={showOccupantTooltip}
      onfocus={showOccupantTooltip}
      {@attach dropzoneClass('occupant-dropzone')}
    >
      <span class="value">{occupancy.occupants.length}</span><span
        class="separator">&sol;</span
      ><span class="max">{occupancy.max}</span>
    </button>
  {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="bastion-occupancy"
      data-occupant-slot={occupancy.slot}
      data-member-uuid={memberUuid}
      onmouseover={showOccupantTooltip}
      onfocus={showOccupantTooltip}
    >
      <span class="value">{occupancy.occupants.length}</span><span
        class="separator">&sol;</span
      ><span class="max">{occupancy.max}</span>
    </div>
  {/if}
{:else}
  <!-- Basic facilities have no slots and will always use this. -->
  <span class="color-text-lightest">&mdash;</span>
{/if}

<style lang="less">
  .bastion-occupancy {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.25rem;
    border-radius: 0.1875rem;

    &.interactive {
      cursor: pointer;

      &:hover {
        background: var(--t5e-faint-color);
      }
    }
  }
</style>
