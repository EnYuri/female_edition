<script lang="ts">
  import { CONSTANTS } from 'src/constants';
  import GroupMemberListItem from './GroupMemberListItem.svelte';
  import { getContext } from 'svelte';
  import type { GroupMemberSection } from 'src/types/group.types';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import TidyTable from 'src/components/table/TidyTable.svelte';
  import TidyTableHeaderRow from 'src/components/table/TidyTableHeaderRow.svelte';
  import TidyTableHeaderCell from 'src/components/table/TidyTableHeaderCell.svelte';
  import HorizontalLineSeparator from 'src/components/layout/HorizontalLineSeparator.svelte';
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import { getSearchResultsContext } from 'src/features/search/search.svelte';
  import { settings } from 'src/settings/settings.svelte';

  interface Props {
    section: GroupMemberSection;
  }

  let { section }: Props = $props();

  const searchResults = getSearchResultsContext();

  const context = $derived(getGroupSheetClassicContext());

  const memberEntries = $derived(section.members.map((member) => ({ member })));

  const visibleMemberCount = $derived(
    searchResults.isSearching
      ? section.members.filter((m) => searchResults.show(m.uuid)).length
      : section.members.length,
  );

  const localize = FoundryAdapter.localize;
</script>

<TidyTable
  key={section.key}
  data-custom-section={section.custom ? true : null}
  expandedOverride={searchResults.isSearching
    ? visibleMemberCount > 0
    : undefined}
>
  {#snippet header()}
    <TidyTableHeaderRow>
      <TidyTableHeaderCell primary={true}>
        {localize(section.label)}
        {#if section.key === CONSTANTS.SHEET_TYPE_NPC && context.isGM}
          <button
            type="button"
            class="section-refresh-npcs inline-icon-button"
            title={localize('TIDY5E.NPC.Refresh.Group.label')}
            onclick={() =>
              context.actor.sheet.refreshMembers(section.members)}
            tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
          >
            <i class="fas fa-arrows-rotate-reverse"></i>
          </button>
        {/if}
      </TidyTableHeaderCell>
    </TidyTableHeaderRow>
  {/snippet}
  {#snippet body()}
    <div class="flex-column small-gap mt-2">
      {#each memberEntries as { member }, index (member.uuid)}
        {#if searchResults.show(member.uuid)}
          <GroupMemberListItem
            {member}
            ctx={context.memberContext[member.id]}
          />

          {#if section.members.length > 1 && index !== section.members.length - 1}
            <HorizontalLineSeparator class="mx-1" borderColor="separator" />
          {/if}
        {/if}
      {/each}
    </div>
  {/snippet}
</TidyTable>
