<script lang="ts">
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { ActiveEffectsHelper } from 'src/utils/active-effect';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type { Attachment } from 'svelte/attachments';
  import type {
    ContainerSheetClassicContext,
    ItemSheetContext,
  } from 'src/types/item.types';
  import type {
    CharacterSheetContext,
    NpcSheetContext,
    VehicleSheetContext,
  } from 'src/types/types';

  interface Props {
    value?: string | null;
    placeholder?: string | null;
    field: string;
    document: any;
    tooltip?: string | null;
    id?: string | null;
    disabled?: boolean;
    /** Override persistence — defaults to `document.update({[field]: value})`. */
    onSave?: (value: string) => void | Promise<unknown>;
    [key: string]: any;
  }

  let {
    value = null,
    placeholder = null,
    field,
    document,
    tooltip = null,
    id = null,
    disabled = false,
    onSave,
    ...rest
  }: Props = $props();

  const context = $derived(
    getSheetContext<
      | CharacterSheetContext
      | NpcSheetContext
      | VehicleSheetContext
      | ContainerSheetClassicContext
      | ItemSheetContext
    >(),
  );

  const localize = FoundryAdapter.localize;

  let activeEffectApplied = $derived(
    ActiveEffectsHelper.isActiveEffectAppliedToField(document, field),
  );
  let isEnchanted = $derived(
    'itemOverrides' in context &&
      context.itemOverrides instanceof Set &&
      context.itemOverrides.has(field),
  );
  let overrideTooltip = $derived(
    isEnchanted
      ? localize('DND5E.ENCHANTMENT.Warning.Override')
      : localize('DND5E.ActiveEffectOverrideWarning'),
  );

  async function saveChange(newValue: string) {
    if (onSave) {
      await onSave(newValue);
      return;
    }
    await document.update({ [field]: newValue });
  }

  /**
   * The formula-input element stops the inner input's `change` propagation and
   * silently assigns `value` when its λ editor closes, so committed values are
   * captured via a capture-phase `change` listener, and by polling `el.editor`
   * after the λ button opens the formula editor.
   */
  const bindFormulaInput: Attachment<HTMLElement> = (element) => {
    const controller = new AbortController();
    const el = element as HTMLElement & {
      value: string;
      editor?: any;
      disabled: boolean;
    };

    // The `value`/`disabled` property setters touch `this.input`, which only
    // exists after the element is connected and `_buildElements` has run — and
    // {@attach} can fire before connection — so all property assignment and
    // listener wiring is deferred to a microtask.
    queueMicrotask(() => {
      el.disabled = disabled || activeEffectApplied;
      el.value = value ?? '';
      let lastCommitted = el.value;

      const commit = (newValue = el.value) => {
        if (newValue !== lastCommitted) {
          lastCommitted = newValue;
          saveChange(newValue ?? '');
        }
      };

      // Capture phase: fires before the inner input's own change handler stops
      // propagation; el.value is not yet updated, so read the inner input's value.
      element.addEventListener(
        'change',
        (ev) => commit((ev.target as HTMLInputElement).value),
        { capture: true, signal: controller.signal },
      );

      element.addEventListener(
        'click',
        (ev) => {
          if ((ev.target as HTMLElement)?.tagName !== 'BUTTON') {
            return;
          }
          const poll = () => (el.editor ? setTimeout(poll, 250) : commit());
          setTimeout(poll, 250);
        },
        { signal: controller.signal },
      );
    });

    return () => controller.abort();
  };
</script>

{#if customElements.get('formula-input')}
  <formula-input
    {id}
    name={field}
    {placeholder}
    data-tooltip={activeEffectApplied ? overrideTooltip : tooltip}
    class={rest.class ?? ''}
    {@attach bindFormulaInput}
  ></formula-input>
{:else}
  <input
    type="text"
    {id}
    {value}
    {placeholder}
    data-tooltip={activeEffectApplied ? overrideTooltip : tooltip}
    class={rest.class ?? ''}
    disabled={disabled || activeEffectApplied}
    onchange={(ev) => saveChange(ev.currentTarget.value)}
  />
{/if}
