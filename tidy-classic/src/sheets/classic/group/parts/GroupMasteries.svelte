<script lang="ts">
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import GroupLanguageTooltip from 'src/tooltips/GroupLanguageTooltip.svelte';

  let context = $derived(getGroupSheetClassicContext());

  let groupMasteryTooltip: GroupLanguageTooltip;
</script>

<div class="flex-row extra-small-gap flex-wrap">
  {#each context.groupMasteries as groupMastery}
    <span
      data-tooltip-direction="UP"
      class="tag"
      onmouseover={(ev) => groupMasteryTooltip.tryShow(ev, groupMastery)}
    >
      {groupMastery.label}
      {#if groupMastery.members.length > 1}
        ({groupMastery.members.length})
      {/if}
    </span>
  {/each}
</div>

<GroupLanguageTooltip
  bind:this={groupMasteryTooltip}
  sheetDocument={context.document}
/>
