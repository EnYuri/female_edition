<script lang="ts">
  import { getGroupSheetClassicContext } from 'src/sheets/sheet-context.svelte';
  import GroupAbilityTooltip from 'src/tooltips/GroupAbilityTooltip.svelte';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { settings } from 'src/settings/settings.svelte';

  const context = $derived(getGroupSheetClassicContext());

  const localize = FoundryAdapter.localize;

  let groupAbilityTooltip: GroupAbilityTooltip;

  let view: 'abilities' | 'saves' = $state('abilities');

  function toggleView() {
    view = view === 'abilities' ? 'saves' : 'abilities';
  }
</script>

<div class="group-abilities">
  <div class="flex-row extra-small-gap align-items-center">
    <button
      type="button"
      class="group-abilities-view-toggle transparent-button inline-icon-button"
      title={view === 'abilities'
        ? localize('DND5E.ClassSaves')
        : localize('DND5E.Abilities')}
      onclick={toggleView}
      tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
    >
      {#if view === 'abilities'}
        <i class="fas fa-hand-fist"></i>
        {localize('DND5E.Abilities')}
      {:else}
        <i class="fas fa-shield-heart"></i>
        {localize('DND5E.ClassSaves')}
      {/if}
      <i class="fa-solid fa-arrow-right-arrow-left"></i>
    </button>
  </div>
  <div class="flex-row extra-small-gap flex-wrap">
    {#each context.groupAbilities as ability}
      <button
        type="button"
        class="tag group-ability-tag"
        data-key={ability.key}
        data-tooltip-direction="UP"
        title={view === 'abilities'
          ? localize('DND5E.AbilityPromptTitle', { ability: ability.name })
          : localize('DND5E.SavePromptTitle', { ability: ability.name })}
        onclick={(event) =>
          view === 'abilities'
            ? context.actor.sheet.onRollAbility({
                ability: ability.key,
                event,
              })
            : context.actor.sheet.onRollSavingThrow({
                ability: ability.key,
                event,
              })}
        onmouseover={(ev) =>
          groupAbilityTooltip.tryShow(ev, {
            key: ability.key,
            label: ability.name,
            members: ability.members.map((m) => ({ actor: m })),
          })}
        onfocus={(ev) =>
          groupAbilityTooltip.tryShow(ev, {
            key: ability.key,
            label: ability.name,
            members: ability.members.map((m) => ({ actor: m })),
          })}
        tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
      >
        {ability.name}
        {#if view === 'abilities'}
          {ability.high.sign}{ability.high.value}
          /
          {ability.low.sign}{ability.low.value}
        {:else}
          {ability.saveHigh.sign}{ability.saveHigh.value}
          /
          {ability.saveLow.sign}{ability.saveLow.value}
        {/if}
      </button>
    {/each}
  </div>
</div>

<GroupAbilityTooltip
  bind:this={groupAbilityTooltip}
  sheetDocument={context.document}
/>

<style lang="less">
  .group-abilities {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .group-ability-tag {
    border: none;
    padding: inherit;

    &:hover {
      cursor: pointer;
    }
  }
</style>
