<script lang="ts">
  import TextInput from 'src/components/inputs/TextInput.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getSheetContext } from 'src/sheets/sheet-context.svelte';
  import type {
    ActorSheetContextV1,
    ActorSheetClassicContextV2,
  } from 'src/types/types';

  let context = $derived(getSheetContext<ActorSheetContextV1 | ActorSheetClassicContextV2>());

  // The classic name field is a live input for editors, so click-to-copy is
  // only offered when the name cannot be edited anyway.
  let canEditName = $derived(
    context.editable && !context.lockSensitiveFields,
  );

  function copyNameToClipboard() {
    game.clipboard?.copyPlainText(context.actor.name);
    ui.notifications.info(
      game.i18n.format('DND5E.Copied', { value: context.actor.name }),
      { console: false },
    );
  }

  const localize = FoundryAdapter.localize;
</script>

<TextInput
  document={context.actor}
  editable={canEditName}
  attributes={!canEditName ? { readonly: true } : {}}
  onclick={!canEditName ? copyNameToClipboard : undefined}
  spellcheck={false}
  placeholder={localize('DND5E.Name')}
  value={context.actor.name}
  field="name"
/>
