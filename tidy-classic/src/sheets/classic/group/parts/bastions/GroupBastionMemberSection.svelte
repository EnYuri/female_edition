<script lang="ts">
  import TidyTable from 'src/components/table/TidyTable.svelte';
  import TidyTableHeaderRow from 'src/components/table/TidyTableHeaderRow.svelte';
  import TidyTableHeaderCell from 'src/components/table/TidyTableHeaderCell.svelte';
  import TidyTableRow from 'src/components/table/TidyTableRow.svelte';
  import { CONSTANTS } from 'src/constants';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import { getSearchResultsContext } from 'src/features/search/search.svelte';
  import { isNil } from 'src/utils/data';
  import { settings } from 'src/settings/settings.svelte';
  import { EventHelper } from 'src/utils/events';
  import type { GroupMemberBastionContext } from 'src/types/group.types';
  import GroupBastionFacilityRow from './GroupBastionFacilityRow.svelte';
  import GroupBastionOccupancy from './GroupBastionOccupancy.svelte';

  interface Props {
    member: GroupMemberBastionContext;
  }

  let { member }: Props = $props();

  const localize = FoundryAdapter.localize;

  let context = $derived(getGroupSheetClassicContext());

  const searchResults = getSearchResultsContext();

  let actor = $derived(member.actor);

  /** Special facilities first, mirroring the character sheet's bastion tab. */
  let facilities = $derived([
    ...member.facilities.special.chosen,
    ...member.facilities.basic.chosen,
  ]);

  let visibleFacilityCount = $derived(
    facilities.filter((chosen) => searchResults.show(chosen.facility.uuid))
      .length,
  );

  let subtitleParts = $derived(
    [
      `${member.facilities.special.value}/${member.facilities.special.max} ${localize(
        'DND5E.FACILITY.Types.Special.Label.other',
      )}`,
      `${member.facilities.basic.value} ${localize(
        'DND5E.FACILITY.Types.Basic.Label.other',
      )}`,
      localize('DND5E.LevelNumber', { level: member.level }),
    ].filter((part) => !!part),
  );
</script>

<TidyTable
  key={actor.uuid}
  class="bastion-member-section"
  expandedOverride={searchResults.isSearching ? visibleFacilityCount > 0 : undefined}
>
  {#snippet header()}
    <TidyTableHeaderRow>
      <TidyTableHeaderCell primary={true}>
        <div
          class="bastion-member-header flex-row small-gap align-items-center"
          data-member-uuid={actor.uuid}
          data-context-menu={CONSTANTS.CONTEXT_MENU_TYPE_GROUP_BASTION_MEMBER}
        >
          <img class="member-portrait" src={actor.img} alt={actor.name} />
          <div class="flex-column flex-1 member-titles">
            <button
              type="button"
              class="inline-transparent-button highlight-on-hover member-name ff-title"
              onclick={() => context.actor.sheet.viewBastionMember(actor)}
              tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
            >
              {actor.name}
              {isNil(member.name, '') ? '' : ` — ${member.name}`}
            </button>
            <div class="separated-list member-subtitle">
              {#each subtitleParts as part, index}
                <span>{part}</span>
                {#if index < subtitleParts.length - 1}
                  <span class="divider-dot"></span>
                {/if}
              {/each}
            </div>
          </div>
        </div>
      </TidyTableHeaderCell>

      <TidyTableHeaderCell
        title={localize('DND5E.FACILITY.FIELDS.hirelings.max.label')}
      >
        <GroupBastionOccupancy
          occupancy={member.hirelings}
          memberUuid={actor.uuid}
        />
      </TidyTableHeaderCell>

      <TidyTableHeaderCell
        title={localize('DND5E.FACILITY.FIELDS.defenders.max.label')}
      >
        <GroupBastionOccupancy
          occupancy={member.defenders}
          memberUuid={actor.uuid}
        />
      </TidyTableHeaderCell>

      <TidyTableHeaderCell class="header-cell-actions">
        <a
          class="inline-icon-button"
          onclick={(ev) =>
            EventHelper.triggerContextMenu(ev, '[data-context-menu]')}
          tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
        >
          <i class="fas fa-ellipsis-vertical"></i>
        </a>
      </TidyTableHeaderCell>
    </TidyTableHeaderRow>
  {/snippet}
  {#snippet body()}
    <div class="flex-column extra-small-gap">
      {#each facilities as chosen (chosen.id)}
        <TidyTableRow hidden={!searchResults.show(chosen.facility.uuid)}>
          <GroupBastionFacilityRow {member} {chosen} />
        </TidyTableRow>
      {/each}

      {#if !facilities.length}
        <div class="bastion-empty-note">
          {localize('TIDY5E.BASTION.Group.Facilities.Empty')}
        </div>
      {/if}
    </div>
  {/snippet}
</TidyTable>

<style lang="less">
  .bastion-member-header {
    .member-portrait {
      --img-size: 2rem;
      width: var(--img-size);
      height: var(--img-size);
      border-radius: 0.1875rem;
      object-fit: cover;
      flex: none;
    }

    .member-titles {
      min-width: 0;
    }

    .member-name {
      font-size: 0.9375rem;
      font-weight: 500;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .member-subtitle {
      display: flex;
      gap: 0.25rem;
      align-items: center;
      font-size: 0.8125rem;
      color: var(--t5e-tertiary-color);

      .divider-dot::before {
        content: '•';
      }
    }
  }

  .bastion-empty-note {
    padding: 0.5rem;
    color: var(--t5e-secondary-color);
    font-style: italic;
  }
</style>
