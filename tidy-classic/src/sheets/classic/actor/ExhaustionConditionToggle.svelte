<script lang="ts">
  import type { Dnd5eActorCondition } from 'src/foundry/foundry-and-system';
  import type { ActorSheetContextV1 } from 'src/types/types';
  import Dnd5eIcon from 'src/components/icon/Dnd5eIcon.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { CONSTANTS } from 'src/constants';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import InlineQuantityTracker from 'src/components/trackers/InlineQuantityTracker.svelte';
  import { processInputChangeDeltaFromValues } from 'src/utils/form';
  import { settings } from 'src/settings/settings.svelte';
  import { error } from 'src/utils/logging';

  const context = $derived(getSheetContext<ActorSheetContextV1>());

  const localize = FoundryAdapter.localize;

  interface Props {
    condition: Dnd5eActorCondition;
  }

  let { condition }: Props = $props();

  // Exhaustion is a numeric actor attribute, not an on/off condition.
  let exhaustionLevel = $derived(context.system.attributes.exhaustion ?? 0);
  let maxExhaustion = $derived(
    context.config?.conditionTypes?.exhaustion?.levels ?? 6,
  );

  async function onLevelChanged(rawValue: string) {
    const newValue = Math.min(
      Math.max(processInputChangeDeltaFromValues(rawValue, exhaustionLevel), 0),
      maxExhaustion,
    );

    if (!Number.isFinite(newValue) || newValue === exhaustionLevel) {
      return;
    }

    try {
      await context.actor.update({
        'system.attributes.exhaustion': newValue,
      });
    } catch (e) {
      error('An error occurred while updating exhaustion', false, e);
      context.actor.sheet?.render();
    }
  }
</script>

<div
  class="condition-toggle-label flex-row small-gap tidy-condition-toggle"
  data-tidy-sheet-part={CONSTANTS.SHEET_PARTS.CONDITION_TOGGLE}
>
  <Dnd5eIcon src={condition.icon} />
  <span class="flex-1 truncate" title={condition.name}>{condition.name}</span>
  <InlineQuantityTracker
    min="0"
    max={maxExhaustion.toString()}
    value={exhaustionLevel}
    disabled={!context.editable}
    aria-label={localize('DND5E.Exhaustion')}
    tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
    onchange={(ev) => onLevelChanged(ev.currentTarget.value)}
  />
</div>

<style lang="less">
  .condition-toggle-label {
    align-items: center;
    min-height: 1.5rem;
  }

  .condition-toggle-label :global(.tidy-inline-quantity-tracker) {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    flex: none;
    height: 1.25rem;
    margin: 0;
  }

  :global(
    .tidy5e-sheet.classic .tidy-inline-quantity-tracker .command
  ) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.125rem;
    line-height: 1;
    color: var(--t5e-tertiary-color);
  }

  :global(
    .tidy5e-sheet.classic
      .tidy-inline-quantity-tracker
      .quantity-tracker-input-wrapper
  ) {
    display: flex;
    align-items: center;
    flex: none;
  }

  :global(
    .tidy5e-sheet.classic
      .tidy-inline-quantity-tracker
      input.quantity-tracker-input
  ) {
    width: 1.5rem;
    flex: none;
    height: 1.25rem;
    text-align: center;
    padding: 0;
  }
</style>
