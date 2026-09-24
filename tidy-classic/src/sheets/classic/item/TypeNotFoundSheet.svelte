<script lang="ts">
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getItemSheetContext } from 'src/sheets/sheet-context.svelte';

  let context = $derived(getItemSheetContext());
  const localize = FoundryAdapter.localize;
</script>

<h2>{localize('FE_TIDY.TypeNotFound.Title')}</h2>

<p>
  {localize('FE_TIDY.TypeNotFound.Prefix')}
  <code>{context.item.type}</code>
  {localize('FE_TIDY.TypeNotFound.Suffix')}
</p>
<p>
  <a
    target="_blank"
    rel="noopener noreferrer"
    href="https://github.com/EnYuri/female_edition/issues"
    >{localize('FE_TIDY.TypeNotFound.Report')}</a
  >.
</p>
