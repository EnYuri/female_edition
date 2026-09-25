<script lang="ts">
  import Dnd5eIcon from 'src/components/icon/Dnd5eIcon.svelte';
  import TidyTableCell from 'src/components/table/TidyTableCell.svelte';
  import { CONSTANTS } from 'src/constants';
  import { getTidyFacilityIcon } from 'src/features/facility/facility';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { EventHelper } from 'src/utils/events';
  import { settings } from 'src/settings/settings.svelte';
  import type { GroupBastionOrderContext } from 'src/types/group.types';
  import GroupBastionProgress from './GroupBastionProgress.svelte';

  interface Props {
    order: GroupBastionOrderContext;
  }

  let { order }: Props = $props();

  let icon = $derived(getTidyFacilityIcon(order.key));
</script>

<div
  class="bastion-order-row flex-row small-gap align-items-center flex-1"
  data-item-id={order.facility.id}
  data-facility-id={order.facility.id}
  data-member-uuid={order.member.uuid}
  data-context-menu={CONSTANTS.CONTEXT_MENU_TYPE_GROUP_BASTION_FACILITY}
>
  <TidyTableCell primary={true} class="text-cell bastion-order-label">
    <span class="bastion-order truncate">
      {#if icon?.type === 'fa-icon-class'}
        <i class={icon.className}></i>
      {:else if icon?.type === 'dnd5e-icon'}
        <Dnd5eIcon src={icon.src}></Dnd5eIcon>
      {/if}
      <!-- Order labels already localized by the system -->
      <span class="truncate">{order.label}</span>
    </span>
  </TidyTableCell>

  <TidyTableCell class="bastion-order-member" baseWidth="8rem">
    <span class="truncate">{order.member.name}</span>
  </TidyTableCell>

  <TidyTableCell class="bastion-order-facility" baseWidth="8rem">
    <a
      class="truncate"
      onclick={() => order.facility.sheet.render(true)}
      tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
      data-info-card={'item'}
      data-info-card-entity-uuid={order.facility.uuid}
    >
      {order.facilityName}
    </a>
  </TidyTableCell>

  <TidyTableCell class="bastion-order-progress" baseWidth="10rem">
    <GroupBastionProgress
      progress={order.progress}
      craft={order.craft}
      memberUuid={order.member.uuid}
      facilityId={order.facility.id}
    />
  </TidyTableCell>

  <TidyTableCell class="bastion-order-cost" baseWidth="3rem">
    {#if order.cost !== null}
      <span>{FoundryAdapter.formatNumber(order.cost)}</span>
    {:else}
      <span class="color-text-lightest">&mdash;</span>
    {/if}
  </TidyTableCell>

  <TidyTableCell class="bastion-order-actions" baseWidth="1.5rem">
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
  .bastion-order-row {
    .bastion-order {
      display: inline-flex;
      gap: 0.25rem;
      align-items: center;
    }
  }
</style>
