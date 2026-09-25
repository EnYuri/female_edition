<script lang="ts">
  import TextInput from 'src/components/inputs/TextInput.svelte';
  import ActivityUseButton from 'src/components/item-list/ActivityUseButton.svelte';
  import RechargeControl from 'src/components/item-list/controls/RechargeControl.svelte';
  import { CONSTANTS } from 'src/constants';
  import { SheetPinsProvider } from 'src/features/sheet-pins/SheetPinsProvider';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type {
    ActorSheetContextV1,
    SheetPinActivityContext,
  } from 'src/types/types';
  import { isNil } from 'src/utils/data';
  import { EventHelper } from 'src/utils/events';
  import { coalesce } from 'src/utils/formatting';
  import { getContext } from 'svelte';

  interface Props {
    ctx: SheetPinActivityContext;
  }

  let { ctx }: Props = $props();

  const tabId = getContext<string>(CONSTANTS.SVELTE_CONTEXT.TAB_ID);

  let img = $derived(
    ctx.document.img ===
      ctx.document.documentConfig?.[ctx.document.type]?.documentClass?.metadata
        ?.img
      ? ctx.document.item.img
      : ctx.document.img,
  );

  let { usesDocument, value, maxText, uses } = $derived.by(() => {
    const uses = ctx.document.uses;

    return {
      usesDocument: ctx.document,
      uses: uses,
      value: (uses.max ?? 0) - uses.spent,
      maxText: isNil(uses.max, '') ? '—' : uses.max.toString(),
    };
  });

  function saveValueChange(
    ev: Event & { currentTarget: EventTarget & HTMLInputElement },
  ): boolean {
    FoundryAdapter.handleDocumentUsesChanged(
      ev,
      usesDocument,
      'uses.value',
      'uses.spent',
      'uses.max',
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

  let localize = FoundryAdapter.localize;
</script>

<div
  class="sheet-pin attribute-pin"
  data-tidy-draggable
  data-item-id={ctx.document.item.id}
  data-activity-id={ctx.document.id}
  data-context-menu={CONSTANTS.CONTEXT_MENU_TYPE_ACTIVITIES}
  data-info-card={'activity'}
  data-info-card-entity-uuid={ctx.document.uuid}
  data-configurable="true"
  data-pin-id={ctx.id}
  onmousedown={(ev) => FoundryAdapter.editOnMiddleClick(ev, ctx.document)}
  ondragstart={onDragStart}
>
  <div class="attribute-document-image">
    <ActivityUseButton activity={ctx.document} {img} disabled={!context.editable} />
  </div>
  <div class="attribute-pin-details">
    <div
      class="attribute-pin-name-container"
      title="{ctx.document.name} | {ctx.document.item.name}"
    >
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
          title="{ctx.document.name} | {ctx.document.item.name}"
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
    {#if ctx.presentation !== 'none'}
      <div class="attribute-counter {ctx.resource}">
        {#if ctx.document.isOnCooldown}
          <RechargeControl document={ctx.document} field="uses.spent" {uses} />
        {:else if ctx.document.hasRecharge}
          <span class="charged-text">
            {#if value > 1}
              <span>{value}</span>
            {/if}
            <i class="fas fa-bolt" title={localize('DND5E.Charged')}></i>
          </span>
        {:else}
          <TextInput
            document={usesDocument}
            field="uses.spent"
            {value}
            onSaveChange={(ev) => saveValueChange(ev)}
            selectOnFocus={true}
          />
          <span class="divider">/</span>
          <span class="max">{maxText}</span>
        {/if}
      </div>
    {/if}
  </div>
  {#if context.unlocked}
    <a
      class="attribute-pins-menu highlight-on-hover"
      onclick={(ev) => EventHelper.triggerContextMenu(ev, '[data-activity-id]')}
    >
      <i class="fas fa-ellipsis-vertical"></i>
    </a>
  {/if}
</div>
