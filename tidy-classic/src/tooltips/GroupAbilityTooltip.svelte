<script lang="ts">
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { getModifierData } from 'src/utils/formatting';
  import { tick } from 'svelte';
  import { Tooltip } from './Tooltip';
  import { getThemeV2 } from 'src/theme/theme';
  import type { Actor5e } from 'src/types/types';
  import type { PortraitShape } from 'src/theme/theme-quadrone.types';
  import { ThemeQuadrone } from 'src/theme/theme-quadrone.svelte';

  const localize = FoundryAdapter.localize;

  interface Props {
    sheetDocument: any;
  }

  let { sheetDocument }: Props = $props();

  let tooltip: HTMLElement;

  type GroupAbilityTooltipData = {
    key: string;
    label: string;
    members: {
      actor: Actor5e;
      portrait?: { shape: PortraitShape };
      highlightColor?: string;
    }[];
  };

  let ability: GroupAbilityTooltipData = $state({
    key: '',
    label: '',
    members: [],
  });

  let highestScore = $derived(
    ability.members.reduce(
      (prev, curr) =>
        Math.max(prev, curr.actor.system.abilities?.[ability.key]?.mod),
      0,
    ),
  );

  export async function tryShow(
    event: Event & { currentTarget: EventTarget & HTMLElement },
    hoveredAbility: GroupAbilityTooltipData,
  ): Promise<any> {
    if (!hoveredAbility.members.length) {
      return;
    }

    ability = hoveredAbility;

    const target = event?.currentTarget;

    await tick();

    Tooltip.show(target, tooltip.outerHTML, getThemeV2(sheetDocument));
  }
</script>

<div class="hidden">
  <div bind:this={tooltip} class="document-list-summary-tooltip">
    <h3 class="font-title-medium color-text-default">{ability.label}</h3>
    <hr />
    <ul>
      <li class="group-ability-grid group-tooltip-header">
        <div class=""></div>
        <div class=""></div>
        <div class="text-align-right font-label-small color-text-lightest">
          {localize('DND5E.AbilityModifierShort')}
        </div>
        <div class="text-align-right font-label-small color-text-lightest">
          {localize('DND5E.AbilityScoreShort')}
        </div>
        <div class="text-align-right font-label-small color-text-lightest">
          {localize('DND5E.SavingThrowShort')}
        </div>
        <div class="text-align-right font-label-small color-text-lightest">
          {localize('DND5E.Proficiency')}
        </div>
      </li>
      {#each ability.members as member}
        {@const memberAbility = member.actor.system.abilities?.[ability.key]}
        {@const modifier = getModifierData(memberAbility?.mod)}
        {@const save = getModifierData(memberAbility?.save?.value)}
        <li class="group-ability-grid">
          <div
            class={['item-image', member.portrait?.shape ?? ThemeQuadrone.DEFAULT_PORTRAIT_SHAPE]}
            style="background-image: url('{member.actor.img}')"
          ></div>
          <div class="item-name truncate">{member.actor.name}</div>
          <div class="text-align-right">
            {#if memberAbility?.mod === highestScore}
              <i
                class="fa-solid fa-award color-text-gold-emphasis highlighted"
                style:color={member.highlightColor}
              ></i>
            {/if}
            <span class="font-body-medium color-text-lighter"
              >{modifier.sign}</span
            >
            <span class="font-label-medium color-text-default"
              >{modifier.value}</span
            >
          </div>
          <div class="text-align-right">
            <span class="font-label-medium color-text-lighter"
              >{memberAbility?.value}</span
            >
          </div>
          <div class="text-align-right">
            <span class="font-body-medium color-text-lighter"
              >{save.sign}</span
            >
            <span class="font-label-medium color-text-default"
              >{save.value}</span
            >
          </div>
          <div class="text-align-right">
            <i
              class="{FoundryAdapter.getProficiencyIconClass(
                memberAbility?.proficient,
              )} fa-fw"
            ></i>
          </div>
        </li>
      {/each}
    </ul>
  </div>
</div>

<style lang="less">
  .group-ability-grid {
    display: grid;
    grid-template-columns: 1.5rem 1fr auto auto auto auto;
    gap: 0.5rem;
    align-items: center;
  }
</style>
