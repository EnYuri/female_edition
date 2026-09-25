<script lang="ts">
  import TextInput from 'src/components/inputs/TextInput.svelte';
  import RechargeControl from 'src/components/item-list/controls/RechargeControl.svelte';
  import ItemUseButton from 'src/components/item-list/ItemUseButton.svelte';
  import { CONSTANTS } from 'src/constants';
  import { SheetPinsProvider } from 'src/features/sheet-pins/SheetPinsProvider';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type { ActorSheetContextV1, SheetPinItemContext } from 'src/types/types';
  import { isNil } from 'src/utils/data';
  import { EventHelper } from 'src/utils/events';
  import { coalesce } from 'src/utils/formatting';
  import SpellPip from 'src/components/pips/SpellPip.svelte';
  import CapacityBar from 'src/sheets/classic/container/CapacityBar.svelte';
  import { Container } from 'src/features/containers/Container';
  import { getContext } from 'svelte';

  interface Props {
    ctx: SheetPinItemContext;
  }

  let { ctx }: Props = $props();

  const tabId = getContext<string>(CONSTANTS.SVELTE_CONTEXT.TAB_ID);

  let { usesDocument, valueProp, spentProp, maxProp, value, maxText, uses } =
    $derived.by(() => {
      if (ctx.linkedUses) {
        return {
          usesDocument: ctx.linkedUses.doc,
          maxProp: ctx.linkedUses.maxProp,
          maxText: isNil(ctx.linkedUses.max, '')
            ? '—'
            : ctx.linkedUses.max.toString(),
          spentProp: ctx.linkedUses.spentProp,
          uses: ctx.linkedUses,
          value: ctx.linkedUses.value,
          valueProp: ctx.linkedUses.valueProp,
        };
      }

      const primaryActivity = ctx.document.system.activities?.contents[0];
      const usePrimaryActivity =
        ctx.document.system.uses.max === '' &&
        !isNil(primaryActivity?.uses?.max, '');
      const uses = usePrimaryActivity
        ? primaryActivity.uses
        : ctx.document.system.uses;

      return {
        usesDocument: usePrimaryActivity ? primaryActivity : ctx.document,
        uses: uses,
        value: (uses.max ?? 0) - uses.spent,
        maxText: isNil(uses.max, '') ? '—' : uses.max.toString(),
        valueProp: usePrimaryActivity ? 'uses.value' : 'system.uses.value',
        spentProp: usePrimaryActivity ? 'uses.spent' : 'system.uses.spent',
        maxProp: usePrimaryActivity ? 'uses.max' : 'system.uses.max',
      };
    });

  function saveValueChange(
    ev: Event & { currentTarget: EventTarget & HTMLInputElement },
  ): boolean {
    FoundryAdapter.handleDocumentUsesChanged(
      ev,
      usesDocument,
      valueProp,
      spentProp,
      maxProp,
    );
    return false;
  }

  function onDragStart(event: DragEvent) {
    const dragData = ctx.document.toDragData?.();

    if (dragData) {
      event.dataTransfer?.setData('text/plain', JSON.stringify(dragData));
    }
  }

  let context = $derived(getSheetContext<ActorSheetContextV1>());

  let spellSlotTrackerMode = $derived(
    (context as any).spellSlotTrackerMode ===
      CONSTANTS.SPELL_SLOT_TRACKER_MODE_PIPS
      ? 'spell-slots-pips'
      : 'spell-slots',
  );
  let spellcastingSection = $derived(
    ctx.document.parent?.system.spells['spell' + ctx.document.system.level],
  );

  // Pinned containers may not be in the container panel, so capacity is
  // computed on demand when the shared item context lacks it.
  let resolvedCapacity: any = $state();

  let containerCapacity = $derived(
    context.itemContext?.[ctx.document.id]?.containerContents?.capacity ??
      resolvedCapacity,
  );

  $effect(() => {
    if (
      ctx.document.type === CONSTANTS.ITEM_TYPE_CONTAINER &&
      !context.itemContext?.[ctx.document.id]?.containerContents?.capacity
    ) {
      Container.computeCapacity(ctx.document).then(
        (capacity) => (resolvedCapacity = capacity),
      );
    }
  });

  let contentsVisibility = $derived(
    ctx.document.type === CONSTANTS.ITEM_TYPE_CONTAINER
      ? Container.getContentsVisibility(ctx.document, {
          unlocked: context.unlocked,
        })
      : 'visible',
  );

  let localize = FoundryAdapter.localize;

  function onPipClick(index: number, section: any, slotKey: string) {
    if (!section) return;

    let isEmpty = index >= (section?.value ?? 0);
    let value = isEmpty ? index + 1 : index;

    context.actor.update({
      [`system.spells.${slotKey}.value`]: value,
    });
  }
</script>

{#snippet spellSlots(section: any, slotKey: string)}
  {#if spellSlotTrackerMode === 'spell-slots'}
    <span class="inline-uses">
      <span class="uses-value">{section?.value}</span>
      <span class="divider">/</span>
      <span class="uses-max">{section?.max}</span>
    </span>
  {:else if spellSlotTrackerMode === 'spell-slots-pips'}
    <div class="pips spell-pips">
      {#each { length: section?.max ?? 0 }, index}
        <SpellPip
          uses={section?.value ?? 0}
          {index}
          temp={index >= section?.max}
          onclick={() => context.editable && onPipClick(index, section, slotKey)}
        />
      {/each}
    </div>
  {/if}
{/snippet}

<div
  role="button"
  tabindex="0"
  class="sheet-pin attribute-pin"
  data-tidy-draggable
  data-item-id={ctx.document.id}
  data-info-card={'item'}
  data-info-card-entity-uuid={ctx.document.uuid}
  data-context-menu={CONSTANTS.CONTEXT_MENU_TYPE_ITEMS}
  data-pin-id={ctx.id}
  onmousedown={(ev) => FoundryAdapter.editOnMiddleClick(ev, ctx.document)}
  ondragstart={onDragStart}
>
  <div class="attribute-document-image">
    <ItemUseButton item={ctx.document} disabled={!context.editable && ctx.presentation !== 'container'} />
  </div>
  <div class="attribute-pin-details">
    <div class="attribute-pin-name-container" title={ctx.document.name}>
      {#if context.unlocked}
        <TextInput
          class="attribute-pin-name"
          document={ctx.document}
          field="name"
          value={ctx.alias}
          selectOnFocus={true}
          placeholder={ctx.document.name}
          onSaveChange={(ev) => {
            if (tabId) {
              SheetPinsProvider.setAlias(
                ctx.document,
                tabId,
                ev.currentTarget.value
              );
            }
            return false;
          }}
        />
        {#if !isNil(ctx.alias?.trim(), '')}
          <i class="fa-solid fa-pencil"></i>
        {/if}
      {:else}
        <button
          type="button"
          class="attribute-pin-name truncate transparent-button"
          title={ctx.document.name}
          onclick={() =>
            ctx.document.sheet?.render({
              force: true,
              mode: CONSTANTS.SHEET_MODE_PLAY,
            })}
        >
          {coalesce(ctx.alias, ctx.document.name)}
        </button>
      {/if}
    </div>
    {#if ctx.presentation === 'container' && contentsVisibility === 'visible' && containerCapacity}
      <div class="pin-container-capacity">
        <CapacityBar
          container={ctx.document}
          capacity={containerCapacity}
          showLabel={false}
        />
      </div>
    {:else if ctx.presentation !== 'none' && ctx.presentation !== 'container'}
      <div class="attribute-counter {ctx.resource}">
        {#if ctx.presentation === 'limited-uses-recharging'}
          <RechargeControl document={usesDocument} field={spentProp} {uses} />
        {:else if ctx.presentation === 'limited-uses-recharged'}
          <span class="charged-text">
            <TextInput
              document={usesDocument}
              field={spentProp}
              {value}
              onSaveChange={(ev) => saveValueChange(ev)}
              selectOnFocus={true}
            />
            <span class="divider">/</span>
            <span class="max">{maxText}</span>
            <i class="fas fa-bolt" title={localize('DND5E.Charged')}></i>
          </span>
        {:else if ctx.presentation === 'spell-slots'}
          {@render spellSlots(
            spellcastingSection,
            `spell${ctx.document.system.level}`,
          )}
        {:else if ctx.presentation === 'spell-slots-pact'}
          {@render spellSlots(ctx.document.parent?.system.spells['pact'], 'pact')}
        {:else if ctx.presentation === 'limited-uses'}
          <TextInput
            document={usesDocument}
            field={spentProp}
            {value}
            onSaveChange={(ev) => saveValueChange(ev)}
            selectOnFocus={true}
          />
          <span class="divider">/</span>
          <span class="max">{maxText}</span>
        {:else if ctx.presentation === 'quantity'}
          <TextInput
            document={ctx.document}
            field={'system.quantity'}
            value={ctx.document.system.quantity}
            selectOnFocus={true}
          />
        {/if}
      </div>
    {:else if ctx.document.system.activities?.size > 0}
      <div class="attribute-counter">
        <span class="pin-activities-count">
          {ctx.document.system.activities.size}
          {localize(
            ctx.document.system.activities.size === 1
              ? 'DND5E.ACTIVITY.Title.one'
              : 'DND5E.ACTIVITY.Title.other',
          )}
        </span>
      </div>
    {/if}
  </div>
  {#if context.unlocked}
    <a
      class="attribute-pins-menu highlight-on-hover"
      onclick={(ev) => EventHelper.triggerContextMenu(ev, '[data-item-id]')}
    >
      <i class="fas fa-ellipsis-vertical"></i>
    </a>
  {/if}
</div>

<style lang="less">
  .pin-container-capacity {
    :global(.tidy-capacity) {
      flex: 1;
    }
  }
</style>
