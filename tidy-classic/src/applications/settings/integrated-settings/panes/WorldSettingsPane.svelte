<script lang="ts">
  import { setContext } from 'svelte';
  import { CONSTANTS } from 'src/constants';
  import WorldSettings from '../../world-settings/WorldSettings.svelte';
  import type {
    WorldSettingsContext,
    WorldSettingsFunctions,
  } from '../../world-settings/WorldSettings.types';

  interface Props {
    context: WorldSettingsContext;
    functions: WorldSettingsFunctions;
    appId: string;
  }

  let { context, functions, appId }: Props = $props();

  setContext(CONSTANTS.SVELTE_CONTEXT.CONTEXT, context);
  setContext(CONSTANTS.SVELTE_CONTEXT.FUNCTIONS, functions);
  setContext(CONSTANTS.SVELTE_CONTEXT.APP_ID, appId);
</script>

<WorldSettings />
