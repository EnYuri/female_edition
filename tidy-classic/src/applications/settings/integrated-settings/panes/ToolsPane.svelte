<script lang="ts">
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import { settings } from 'src/settings/settings.svelte';
  import { WorldTabConfigurationQuadroneApplication } from 'src/applications/tab-configuration/WorldTabConfigurationQuadroneApplication.svelte';
  import { WorldHeaderControlConfigurationQuadroneApplication } from 'src/applications/header-control-configuration/WorldHeaderControlConfigurationQuadroneApplication.svelte';
  import { ThemeSettingsQuadroneApplication } from 'src/applications/theme/ThemeSettingsQuadroneApplication.svelte';
  import { ApplyTidySheetPreferencesApplication } from 'src/applications/sheet-preferences/ApplyTidySheetPreferencesApplication.svelte';
  import { BulkMigrationsApplication } from 'src/migrations/BulkMigrationsApplication';
  import { ResetSettingsDialog } from 'src/settings/ResetSettingsDialog';

  const localize = FoundryAdapter.localize;

  const tools = [
    {
      label: 'TIDY5E.SettingsMenu.TabConfiguration.label',
      icon: 'fa-solid fa-table-columns',
      open: () =>
        new WorldTabConfigurationQuadroneApplication().render({ force: true }),
    },
    {
      label: 'TIDY5E.SettingsMenu.HeaderControlConfiguration.label',
      icon: 'fa-solid fa-up-to-dotted-line',
      open: () =>
        new WorldHeaderControlConfigurationQuadroneApplication().render({
          force: true,
        }),
    },
    {
      label: 'TIDY5E.SettingsMenu.WorldThemeSettings.label',
      icon: 'fa-solid fa-swatchbook',
      open: () =>
        new ThemeSettingsQuadroneApplication().render({ force: true }),
    },
    {
      label: 'TIDY5E.Settings.SheetPreferences.buttonLabel',
      icon: 'fa-solid fa-file-circle-check',
      open: () =>
        new ApplyTidySheetPreferencesApplication().render({ force: true }),
    },
    {
      label: 'TIDY5E.Settings.Migrations.buttonLabel',
      icon: 'fa-solid fa-right-left',
      open: () => new BulkMigrationsApplication().render({ force: true }),
    },
    {
      label: 'TIDY5E.Settings.Reset.name',
      icon: 'fa-solid fa-broom-wide',
      open: () => new ResetSettingsDialog().render({ force: true }),
    },
  ];
</script>

<div class="tools-pane flex-column small-gap">
  {#each tools as tool}
    <button
      type="button"
      class="tools-button"
      onclick={() => tool.open()}
      tabindex={settings.value.useAccessibleKeyboardSupport ? 0 : -1}
    >
      <i class={tool.icon}></i>
      {localize(tool.label)}
    </button>
  {/each}
</div>

<style lang="less">
  .tools-pane {
    padding: 0.5rem;
  }

  .tools-button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    min-height: 2rem;
    text-align: left;
  }
</style>
