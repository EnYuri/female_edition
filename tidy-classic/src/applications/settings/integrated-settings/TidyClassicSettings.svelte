<script lang="ts">
  import { CONSTANTS } from 'src/constants';
  import { FoundryAdapter } from 'src/foundry/foundry-adapter';
  import type {
    IntegratedSettingsContext,
    TidyClassicSettingsApplication,
  } from './TidyClassicSettingsApplication.svelte';
  import type { UserSettingsFormApplication } from '../user-settings/UserSettingsFormApplication.svelte';
  import type { WorldSettingsFormApplication } from '../world-settings/WorldSettingsFormApplication.svelte';
  import type { ThemeSettingsFormApplication } from '../../theme/ThemeSettingsFormApplication.svelte';
  import type { HomebrewSettingsApplication } from '../../homebrew-settings/HomebrewSettingsApplication.svelte';
  import UserSettingsPane from './panes/UserSettingsPane.svelte';
  import WorldSettingsPane from './panes/WorldSettingsPane.svelte';
  import ThemeSettingsPane from './panes/ThemeSettingsPane.svelte';
  import HomebrewSettingsPane from './panes/HomebrewSettingsPane.svelte';
  import ToolsPane from './panes/ToolsPane.svelte';
  import About from '../about/About.svelte';

  type Providers = {
    user: UserSettingsFormApplication;
    world: WorldSettingsFormApplication;
    theme: ThemeSettingsFormApplication;
    homebrew: HomebrewSettingsApplication;
  };

  interface Props {
    app: TidyClassicSettingsApplication;
    context: IntegratedSettingsContext;
    providers: Providers;
  }

  let { app, context, providers }: Props = $props();

  const localize = FoundryAdapter.localize;

  let selected = $state('user');

  let sections = $derived.by(() => {
    const result = [
      { id: 'user', label: 'TIDY5E.UserSettings.Menu.label' },
    ];

    if (context.isGM) {
      result.push({ id: 'world', label: 'TIDY5E.WorldSettings.Menu.label' });
    }

    result.push({
      id: 'theme',
      label: 'TIDY5E.ThemeSettings.SheetMenu.buttonLabel',
    });

    if (context.isGM) {
      result.push(
        { id: 'homebrew', label: 'TIDY5E.SettingsMenu.Homebrew.label' },
        { id: 'tools', label: 'TIDY5E.IntegratedSettings.Tools.label' },
      );
    }

    result.push({ id: 'about', label: 'FE_TIDY.About.buttonLabel' });

    return result;
  });

  const userFunctions = {
    save: () => providers.user.saveChangedSettings(),
    apply: () => providers.user.applyChangedSettings(),
    validate: (ctx: any) => providers.user.validate(ctx),
  };

  const worldFunctions = {
    save: () => providers.world.saveChangedSettings(),
    apply: () => providers.world.applyChangedSettings(),
    resetDefaultTabs: (sheetType: string) =>
      providers.world.resetDefaultTabs(sheetType),
  };

  const themeFunctions = {
    save: (newSettings: any) =>
      providers.theme.saveChangedSettings(newSettings),
    exportTheme: (newSettings: any) =>
      providers.theme.exportTheme(newSettings),
  };
</script>

<div class="integrated-settings">
  <div role="presentation" class="vertical-tab-container flex-column no-gap">
    <nav role="tablist" class="tidy-tabs vertical">
      {#each sections as section (section.id)}
        <a
          class={[
            CONSTANTS.TAB_OPTION_CLASS,
            { active: section.id === selected },
          ]}
          role="tab"
          aria-selected={section.id === selected}
          onclick={() => (selected = section.id)}
          tabindex={section.id === selected ? 0 : -1}
        >
          <span class="tab-title">{localize(section.label)}</span>
        </a>
      {/each}
    </nav>
    <div role="presentation" class="remaining-vertical-space"></div>
  </div>

  <div role="presentation" class="integrated-settings-body">
    {#if selected === 'user' && providers.user.context}
      <UserSettingsPane
        context={providers.user.context}
        functions={userFunctions}
        appId={app.appId}
      />
    {:else if selected === 'world' && providers.world.context}
      <WorldSettingsPane
        context={providers.world.context}
        functions={worldFunctions}
        appId={app.appId}
      />
    {:else if selected === 'theme'}
      <ThemeSettingsPane
        themeableColors={providers.theme.themeableColors}
        settings={providers.theme.settings}
        functions={themeFunctions}
        appId={app.appId}
      />
    {:else if selected === 'homebrew'}
      <HomebrewSettingsPane
        app={providers.homebrew}
        config={providers.homebrew._config}
      />
    {:else if selected === 'tools'}
      <ToolsPane />
    {:else if selected === 'about'}
      <About />
    {/if}
  </div>
</div>

<style lang="less">
  .integrated-settings {
    height: 100%;
    display: grid;
    grid-template-areas:
      'nav body';
    grid-template-rows: 1fr;
    grid-template-columns: 15rem 1fr;
    gap: 0.5rem;

    .vertical-tab-container {
      grid-area: nav;
      margin-top: -0.5rem;
      margin-left: -0.5rem;
      margin-bottom: -0.5rem;
    }

    .remaining-vertical-space {
      margin-right: -0.0625rem;
      border-right: 0.0625rem solid var(--t5e-tab-strip-border-color);
      flex: 1;
      background-color: var(--t5e-header-background);
    }
  }

  .integrated-settings-body {
    grid-area: body;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;

    :global(.settings-form) {
      height: auto;
      flex: 1;
      min-height: 0;
    }
  }

  nav.tidy-tabs {
    a {
      cursor: pointer;
    }
  }
</style>
