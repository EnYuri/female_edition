<script lang="ts">
  import { CONSTANTS } from 'src/constants';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getEffectChangeFieldLabelKey } from 'src/foundry/core-compat';
  import type { ActiveEffect5e, EffectSummaryData } from 'src/types/types';
  import HorizontalLineSeparator from '../layout/HorizontalLineSeparator.svelte';
  import { ActiveEffectsHelper } from 'src/utils/active-effect';
  import PropertyTag from '../properties/PropertyTag.svelte';

  interface Props {
    activeEffect: ActiveEffect5e;
    summaryData: EffectSummaryData;
  }

  let { activeEffect, summaryData }: Props = $props();

  let pills = $derived.by(() =>
    ActiveEffectsHelper.getActiveEffectPills(activeEffect),
  );

  const localize = FoundryAdapter.localize;
</script>

<div
  class="item-summary"
  data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.ITEM_SUMMARY}
>
  {@html summaryData.description.value}
  <HorizontalLineSeparator />
  {#if activeEffect.changes.length}
    <table class="effect-summary-changes-table">
      <colgroup>
        <col width="50%" />
        <col width="25%" />
        <col width="25%" />
      </colgroup>
      <thead>
        <tr>
          <th>
            {localize(getEffectChangeFieldLabelKey('key'))}
          </th>
          <th>
            {localize(getEffectChangeFieldLabelKey('type'))}
          </th>
          <th>
            {localize(getEffectChangeFieldLabelKey('value'))}
          </th>
        </tr>
      </thead>
      <tbody>
        {#each summaryData.changes ?? activeEffect.changes as change}
          {@const modeLabel = ActiveEffectsHelper.findMode(change)}

          <tr>
            <td
              title={change.key}
              class="truncate"
              style="word-wrap: break-all"
            >
              <span class="effect-change-label flex-column">
                <span class="effect-change-key">{change.key}</span>
                {#if 'name' in change && change.name && change.name !== change.key}
                  <span class="effect-change-name">{change.name}</span>
                {/if}
              </span>
            </td>
            <td>
              {modeLabel}
            </td>
            <td title={change.value} class="break-word">
              {change.value}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  {#if pills.length}
    <div
      class="inline-wrapped-elements"
      data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.ITEM_PROPERTY_LIST}
    >
      {#each pills as pill}
        <PropertyTag prop={localize(pill)} showParenthetical={true} />
      {/each}
    </div>
  {/if}
</div>

<style lang="less">
  .effect-summary-changes-table {
    table-layout: fixed;

    th {
      text-align: left;
    }

    th,
    td {
      padding: 0.25rem;
    }

    .effect-change-name {
      color: var(--t5e-tertiary-color);
      font-size: 0.75rem;
    }
  }
</style>
