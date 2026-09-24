<script lang="ts">
  import { setContext } from 'svelte';
  import { CONSTANTS } from 'src/constants';
  import UserSettings from '../../user-settings/UserSettings.svelte';
  import type {
    UserSettingsContext,
    UserSettingsFunctions,
  } from '../../user-settings/UserSettings.types';

  interface Props {
    context: UserSettingsContext;
    functions: UserSettingsFunctions;
    appId: string;
  }

  let { context, functions, appId }: Props = $props();

  setContext(CONSTANTS.SVELTE_CONTEXT.CONTEXT, context);
  setContext(CONSTANTS.SVELTE_CONTEXT.FUNCTIONS, functions);
  setContext(CONSTANTS.SVELTE_CONTEXT.APP_ID, appId);
  setContext('initialTabId', CONSTANTS.TAB_USER_SETTINGS_PLAYERS);
</script>

<UserSettings />
