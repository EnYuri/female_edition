<script lang="ts">
  import HomebrewSettings from '../../../homebrew-settings/HomebrewSettings.svelte';
  import type {
    HomebrewConfigContext,
    HomebrewSettingsApplication,
  } from '../../../homebrew-settings/HomebrewSettingsApplication.svelte';

  interface Props {
    app: HomebrewSettingsApplication;
    config: HomebrewConfigContext;
  }

  let { app, config }: Props = $props();
</script>

<HomebrewSettings {app} {config} />
