<script lang="ts">
  import { setContext } from 'svelte';
  import { CONSTANTS } from 'src/constants';
  import ThemeSettingsSheet from '../../../theme/ThemeSettingsSheet.svelte';
  import type { ThemeSettingsSheetFunctions } from '../../../theme/ThemeSettingsFormApplication.svelte';
  import type { CurrentSettings } from 'src/settings/settings.svelte';
  import type { ThemeColorSetting } from 'src/types/theme.types';

  interface Props {
    themeableColors: ThemeColorSetting[];
    settings: CurrentSettings;
    functions: ThemeSettingsSheetFunctions;
    appId: string;
  }

  let { themeableColors, settings, functions, appId }: Props = $props();

  setContext(CONSTANTS.SVELTE_CONTEXT.FUNCTIONS, functions);
  setContext(CONSTANTS.SVELTE_CONTEXT.APP_ID, appId);
</script>

<ThemeSettingsSheet {themeableColors} {settings} />
