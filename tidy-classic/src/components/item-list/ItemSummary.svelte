<script lang="ts">
  import ItemSummaryCommandButtonList from '../item-summary/ItemSummaryCommandButtonList.svelte';
  import type { Item5e, ItemChatData } from 'src/types/item.types';
  import { ItemSummaryRuntime } from 'src/runtime/ItemSummaryRuntime';
  import HorizontalLineSeparator from '../layout/HorizontalLineSeparator.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { CONSTANTS } from 'src/constants';
  import { Enrichers } from 'src/features/enrichers/Enrichers';
  import InlineActivitiesList from './InlineActivitiesList.svelte';
  import { Activities } from 'src/features/activities/activities';
  import type { ActivityItemContext } from 'src/types/types';
  import { settings } from 'src/settings/settings.svelte';
  import { ItemProperties } from 'src/features/properties/ItemProperties.svelte';
  import PropertyTag from '../properties/PropertyTag.svelte';
  import InlineEffectsList from './InlineEffectsList.svelte';
  import VehicleItemCrew from 'src/sheets/classic/vehicle/parts/VehicleItemCrew.svelte';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';

  interface Props {
    chatData: ItemChatData;
    item: Item5e;
  }

  let { chatData, item }: Props = $props();

  let context = $derived(getSheetContext());

  let additionalItemProps = $derived(
    ItemProperties.getAdditionalItemProperties(item),
  );

  let itemSummaryCommands = $derived(
    ItemSummaryRuntime.getItemSummaryCommands(item),
  );
  let concealDetails = $derived(FoundryAdapter.concealDetails(item));

  let linked = $derived<Item5e>(item?.system?.linkedActivity?.item);

  const localize = FoundryAdapter.localize;

  let activities = $derived.by(() => {
    return item
      ? Activities.getVisibleActivities(
          item,
          item.system.activities,
        ).map<ActivityItemContext>(Activities.getActivityItemContext)
      : [];
  });

  let identified = $derived(item.system.identified !== false);

  let isGm = $derived(FoundryAdapter.userIsGm());
  let gmEditMode = $derived(FoundryAdapter.isInGmEditMode(context.document));
  let showGmOnlyUi = $derived(!identified && gmEditMode);
  let unidentifiedDescription = $derived(item.system.unidentified?.description);
  let showGmUnidentifiedDescription = $derived(
    isGm && !identified && !!unidentifiedDescription,
  );
  let showGmSecretDescription = $derived(
    isGm && !identified && !gmEditMode,
  );
  let enrichmentOptions = $derived({
    relativeTo: item,
    rollData: item.getRollData(),
    secrets: item.isOwner,
  });
</script>

{#if activities.length > 0 && settings.value.inlineActivitiesPosition === CONSTANTS.INLINE_ACTIVITIES_POSITION_TOP}
  <InlineActivitiesList {item} {activities} />
  <HorizontalLineSeparator />
{/if}
<div
  class="item-summary"
  data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.ITEM_SUMMARY}
>
  {#if linked}
    {#await FoundryAdapter.enrichHtml(Enrichers.reference(linked.uuid, linked.name)) then enriched}
      <div class="item-summary-linked-source">
        {@html localize('TIDY5E.Activities.Cast.SourceHintText', {
          itemName: enriched,
        })}
      </div>
    {/await}
    <HorizontalLineSeparator />
  {/if}

  <div class={['user-select-text', { 'gm-view-callout': showGmOnlyUi }]}>
    {#if !identified}
      <span class="unidentified-notice">
        {localize('DND5E.Unidentified.Notice')}
      </span>
    {/if}
    {#if showGmUnidentifiedDescription}
      <div
        class={[
          'item-summary-unidentified',
          { 'gm-view-callout': showGmOnlyUi },
        ]}
      >
        {#await FoundryAdapter.enrichHtml(unidentifiedDescription, enrichmentOptions) then enriched}
          {@html enriched}
        {/await}
      </div>
    {/if}
    <div
      data-target="system.description.value"
      data-uuid={item.uuid}
      class={{ 'gm-secret-block': showGmSecretDescription }}
    >
      {#if showGmSecretDescription}
        <div class="gm-only">
          {localize(
            'TIDY5E.WorldSettings.ItemIdentificationPermission.options.GmOnly',
          )}
        </div>
      {/if}
      {@html chatData.description}
    </div>
  </div>

  <InlineEffectsList {item} />

  {#if item.system.crew?.max}
    <VehicleItemCrew {item} />
  {/if}

  {#if itemSummaryCommands.length}
    <HorizontalLineSeparator />
    <div class="inline-wrapped-elements">
      <ItemSummaryCommandButtonList {item} />
    </div>
  {/if}

  {#if chatData.properties}
    <HorizontalLineSeparator />
    <div
      class="inline-wrapped-elements"
      class:conceal-content={concealDetails}
      data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.ITEM_PROPERTY_LIST}
    >
      {#each chatData.properties as prop}
        <span class="tag">
          <span class="value">{prop}</span>
        </span>
      {/each}
      {#each additionalItemProps as prop}
        <PropertyTag {prop} showParenthetical={true} />
      {/each}
    </div>
  {/if}
</div>
{#if activities.length && settings.value.inlineActivitiesPosition === CONSTANTS.INLINE_ACTIVITIES_POSITION_BOTTOM}
  <HorizontalLineSeparator />
  <InlineActivitiesList {item} {activities} />
{/if}

<style lang="less">
  .unidentified-notice {
    color: var(--t5e-tertiary-color);
    display: block;
    font-style: italic;
    margin-bottom: 0.25rem;
  }

  .gm-view-callout {
    border-left: 0.1875rem solid var(--t5e-primary-accent-color);
    padding-left: 0.5rem;
  }

  .item-summary-unidentified {
    margin-bottom: 0.5rem;
  }

  .gm-secret-block {
    background: var(--t5e-secret-background);
    border-radius: 0.3125rem;
    padding: 0.25rem 0.5rem;
  }

  .gm-only {
    color: var(--t5e-tertiary-color);
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
  }
</style>
