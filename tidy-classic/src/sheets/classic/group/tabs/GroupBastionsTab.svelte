<script lang="ts">
  import SheetPins from 'src/sheets/classic/actor/parts/SheetPins.svelte';
  import { CONSTANTS } from 'src/constants';
  import { getContext, setContext } from 'svelte';
  import UtilityToolbar from 'src/components/utility-bar/UtilityToolbar.svelte';
  import Search from 'src/components/utility-bar/Search.svelte';
  import UtilityToolbarCommand from 'src/components/utility-bar/UtilityToolbarCommand.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { UserSheetPreferencesService } from 'src/features/user-preferences/SheetPreferencesService';
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import {
    createSearchResultsState,
    setSearchResultsContext,
  } from 'src/features/search/search.svelte';
  import TidyTable from 'src/components/table/TidyTable.svelte';
  import TidyTableHeaderRow from 'src/components/table/TidyTableHeaderRow.svelte';
  import TidyTableHeaderCell from 'src/components/table/TidyTableHeaderCell.svelte';
  import OccupantSummaryTooltip from 'src/tooltips/OccupantSummaryTooltip.svelte';
  import GroupBastionMemberSection from '../parts/bastions/GroupBastionMemberSection.svelte';
  import GroupBastionOrderRow from '../parts/bastions/GroupBastionOrderRow.svelte';
  import TidyTableRow from 'src/components/table/TidyTableRow.svelte';
  import type {
    GroupBastionOrderContext,
    GroupMemberBastionContext,
  } from 'src/types/group.types';

  const tabId = getContext<string>(CONSTANTS.SVELTE_CONTEXT.TAB_ID);

  const context = $derived(getGroupSheetClassicContext());

  let showSheetPins = $derived(
    UserSheetPreferencesService.getDocumentTypeTabPreference(
      context.document.type,
      tabId,
      'showSheetPins',
    ) ?? true,
  );

  const localize = FoundryAdapter.localize;

  let searchCriteria: string = $state('');

  const searchResults = createSearchResultsState();
  setSearchResultsContext(searchResults);

  // One tooltip for the whole tab; every occupancy cell borrows it.
  let occupantSummaryTooltip = $state<OccupantSummaryTooltip | undefined>();
  setContext(
    CONSTANTS.SVELTE_CONTEXT.OCCUPANT_SUMMARY_TOOLTIP,
    () => occupantSummaryTooltip,
  );

  let utilityBarCommands = $derived(
    context.utilities[tabId]?.utilityToolbarCommands ?? [],
  );

  let members = $derived(context.bastionsContext.members);
  let orders = $derived(context.bastionsContext.orders);

  let hasMembers = $derived(members.length > 0);

  let visibleOrders = $derived(
    orders.filter((order) => searchResults.show(order.facility.uuid)),
  );

  let showOrdersTable = $derived(
    visibleOrders.length > 0 || !searchResults.isSearching,
  );

  $effect(() => {
    searchResults.criteria = searchCriteria;
    searchResults.uuids = getBastionSearchUuids(
      searchCriteria,
      members,
      orders,
    );
  });

  function includesCriteria(
    value: string | null | undefined,
    criteria: string,
  ) {
    return !!value && value.toLowerCase().includes(criteria);
  }

  /** Match orders, facility names, crafted items, bastion names, and character names. */
  function getBastionSearchUuids(
    criteriaText: string,
    members: GroupMemberBastionContext[],
    orders: GroupBastionOrderContext[],
  ) {
    const criteria = criteriaText.trim().toLowerCase();
    if (!criteria) {
      return undefined;
    }

    const uuids = new Set<string>();

    for (const order of orders) {
      if (
        includesCriteria(order.label, criteria) ||
        includesCriteria(order.facilityName, criteria) ||
        includesCriteria(order.craft?.name, criteria) ||
        includesCriteria(order.member.name, criteria) ||
        includesCriteria(order.member.system.bastion?.name, criteria)
      ) {
        uuids.add(order.facility.uuid);
        uuids.add(order.member.uuid);
      }
    }

    for (const member of members) {
      const actor = member.actor;
      const bastionMatches =
        includesCriteria(member.name, criteria) ||
        includesCriteria(actor.name, criteria);

      const facilities = [
        ...member.facilities.special.chosen,
        ...member.facilities.basic.chosen,
      ];

      for (const chosen of facilities) {
        const facilityMatches =
          includesCriteria(chosen.name, criteria) ||
          includesCriteria(chosen.labels?.order, criteria) ||
          includesCriteria(chosen.craft?.name, criteria);

        if (bastionMatches || facilityMatches) {
          uuids.add(chosen.facility.uuid);
          uuids.add(actor.uuid);
        }
      }

      if (bastionMatches) {
        uuids.add(actor.uuid);
      }
    }

    return uuids;
  }
</script>

<UtilityToolbar>
  <Search bind:value={searchCriteria} />
  {#each utilityBarCommands as command (command.id)}
    <UtilityToolbarCommand
      title={command.title}
      iconClass={command.iconClass}
      text={command.text}
      visible={command.visible ?? true}
      onExecute={(ev) => command.execute?.(ev)}
    />
  {/each}
</UtilityToolbar>
{#if showSheetPins}
  <SheetPins />
{/if}

<OccupantSummaryTooltip
  bind:this={occupantSummaryTooltip}
  sheetDocument={context.document}
/>

<section class="scroll-container flex-column small-gap" data-tidy-track-scroll-y>
  {#if hasMembers}
    {#if showOrdersTable}
      <TidyTable
        key="bastion-orders"
        class="bastion-orders"
        expandedOverride={searchResults.isSearching
          ? visibleOrders.length > 0
          : undefined}
      >
        {#snippet header()}
          <TidyTableHeaderRow>
            <TidyTableHeaderCell primary={true}>
              <h3 class="bastion-orders-title">
                <i class="fas fa-scroll"></i>
                {localize('DND5E.FACILITY.Orders.Label')}
                <span class="counter">
                  <span class="value">{visibleOrders.length}</span>
                </span>
              </h3>
            </TidyTableHeaderCell>
          </TidyTableHeaderRow>
        {/snippet}
        {#snippet body()}
          <div class="flex-column extra-small-gap">
            {#each orders as order (order.facility.uuid)}
              <TidyTableRow hidden={!searchResults.show(order.facility.uuid)}>
                <GroupBastionOrderRow {order} />
              </TidyTableRow>
            {/each}

            {#if !orders.length}
              <div class="bastion-empty-note">
                {localize('TIDY5E.BASTION.Group.Orders.Empty')}
              </div>
            {/if}
          </div>
        {/snippet}
      </TidyTable>
    {/if}

    {#each members as member (member.actor.uuid)}
      {#if searchResults.show(member.actor.uuid)}
        <GroupBastionMemberSection {member} />
      {/if}
    {/each}
  {:else}
    <div class="bastion-empty-note">
      {localize('TIDY5E.BASTION.Group.Empty')}
    </div>
  {/if}
</section>

<style lang="less">
  .bastion-orders-title {
    margin: 0;
    display: flex;
    gap: 0.25rem;
    align-items: center;

    .counter {
      padding-left: 0.25rem;
      color: var(--t5e-tertiary-color);

      .value {
        color: var(--t5e-secondary-color);
      }
    }
  }

  .bastion-empty-note {
    padding: 0.5rem;
    color: var(--t5e-secondary-color);
    font-style: italic;
  }
</style>
