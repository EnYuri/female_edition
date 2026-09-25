<script lang="ts">
  import TidyTableCell from 'src/components/table/TidyTableCell.svelte';
  import InlineSvg from 'src/components/utility/InlineSvg.svelte';
  import { CONSTANTS } from 'src/constants';
  import { calculateOccupancy } from 'src/features/facility/Bastion';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import { EventHelper } from 'src/utils/events';
  import { settings } from 'src/settings/settings.svelte';
  import type {
    ChosenFacilityContext,
  } from 'src/types/types';
  import type { GroupMemberBastionContext } from 'src/types/group.types';
  import GroupBastionOccupancy from './GroupBastionOccupancy.svelte';
  import GroupBastionProgress from './GroupBastionProgress.svelte';

  interface Props {
    member: GroupMemberBastionContext;
    chosen: ChosenFacilityContext;
  }

  let { member, chosen }: Props = $props();

  const localize = FoundryAdapter.localize;

  let context = $derived(getGroupSheetClassicContext());

  let memberUuid = $derived(member.actor.uuid);

  // Disabled facilities show the repair icon like on character sheets
  let img = $derived(
    !chosen.disabled
      ? chosen.img
      : CONFIG.DND5E.facilities.orders.repair.icon,
  );

  const basicSvgFilePathRegex = /\.svg$/i;

  function isSvg(iconPath: string) {
    return basicSvgFilePathRegex.test(iconPath?.trim());
  }

  function useFacility(ev: MouseEvent) {
    if (!context.editable) {
      return;
    }

    context.actor.sheet.useMemberFacility(member.actor, chosen.id, ev);
  }

  let hirelingsOccupancy = $derived(calculateOccupancy([chosen], 'hirelings'));
  let defendersOccupancy = $derived(calculateOccupancy([chosen], 'defenders'));
</script>

<div
  class={[
    'bastion-facility-row flex-row small-gap align-items-center flex-1',
    chosen.isSpecial
      ? CONSTANTS.FACILITY_TYPE_SPECIAL
      : CONSTANTS.FACILITY_TYPE_BASIC,
    { disabled: chosen.disabled, building: chosen.building.built === false },
  ]}
  data-item-id={chosen.id}
  data-facility-id={chosen.id}
  data-member-uuid={memberUuid}
  data-context-menu={CONSTANTS.CONTEXT_MENU_TYPE_GROUP_BASTION_FACILITY}
>
  <a
    class="facility-use-button"
    onclick={useFacility}
    data-info-card={'item'}
    data-info-card-entity-uuid={chosen.facility.uuid}
    tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
  >
    {#if isSvg(img)}
      <InlineSvg class="facility-image" svgUrl={img} />
    {:else}
      <img class="facility-image" src={img} alt={chosen.name} />
    {/if}
  </a>

  <TidyTableCell primary={true} class="text-cell facility-label">
    <a
      class="facility-name"
      onmousedown={(ev) => FoundryAdapter.editOnMiddleClick(ev, chosen.facility)}
      onclick={useFacility}
    >
      <h4 class="truncate">{chosen.name}</h4>
      <span class="subtitle truncate">
        {@html chosen.subtitle}
      </span>
    </a>
  </TidyTableCell>

  <TidyTableCell class="bastion-facility-progress" baseWidth="10rem">
    <GroupBastionProgress
      progress={chosen.progress}
      craft={chosen.craft}
      {memberUuid}
      facilityId={chosen.id}
    />
  </TidyTableCell>

  <TidyTableCell
    class="bastion-facility-occupancy"
    baseWidth="2.5rem"
    title={localize('DND5E.FACILITY.FIELDS.hirelings.max.label')}
  >
    <GroupBastionOccupancy
      occupancy={hirelingsOccupancy}
      {memberUuid}
      facilityId={chosen.id}
    />
  </TidyTableCell>

  <TidyTableCell
    class="bastion-facility-occupancy"
    baseWidth="2.5rem"
    title={localize('DND5E.FACILITY.FIELDS.defenders.max.label')}
  >
    <GroupBastionOccupancy
      occupancy={defendersOccupancy}
      {memberUuid}
      facilityId={chosen.id}
    />
  </TidyTableCell>

  <TidyTableCell class="bastion-facility-actions" baseWidth="1.5rem">
    <a
      class="inline-icon-button"
      onclick={(ev) =>
        EventHelper.triggerContextMenu(ev, '[data-context-menu]')}
      tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
    >
      <i class="fas fa-ellipsis-vertical"></i>
    </a>
  </TidyTableCell>
</div>

<style lang="less">
  .bastion-facility-row {
    .facility-use-button {
      flex: none;
      display: flex;
    }

    :global(.facility-image),
    .facility-image {
      --img-size: 2rem;
      --icon-fill: var(--t5e-tertiary-color);
      width: var(--img-size);
      height: var(--img-size);
      border-radius: 0.1875rem;
      object-fit: cover;
    }

    .facility-name {
      display: flex;
      flex-direction: column;
      min-width: 0;

      h4 {
        margin: 0;
        font-size: 0.9375rem;
        font-weight: 500;
      }

      .subtitle {
        font-size: 0.8125rem;
        color: var(--t5e-secondary-color);
      }
    }

    &.disabled {
      filter: grayscale(1);
    }
  }
</style>
