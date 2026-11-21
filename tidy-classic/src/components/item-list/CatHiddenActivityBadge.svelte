<script lang="ts">
  import { isCatHiddenActivity } from 'src/integration/cat.js';

  let { activity }: { activity: any } = $props();
</script>

{#if game.user.isGM && isCatHiddenActivity(activity)}
  <i class="fa-solid fa-shield-cat cat-activity-badge"
    role="img"
    aria-label={game.i18n.localize('CAT.MEDKIT.Activity.Hidden.Badge')}
    data-tooltip="CAT.MEDKIT.Activity.Hidden.Badge"></i>
{/if}

<style>
  .cat-activity-badge {
    color: var(--cat-status-blue);
    flex-shrink: 0;
  }
</style>
