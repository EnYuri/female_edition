import { CONSTANTS } from 'src/constants';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import { SvelteApplicationMixin } from 'src/mixins/SvelteApplicationMixin.svelte';
import type { ApplicationConfiguration } from 'src/types/application.types';
import { applyThemeToApplication } from 'src/utils/applications.svelte';
import { mount } from 'svelte';
import { UserSettingsFormApplication } from '../user-settings/UserSettingsFormApplication.svelte';
import type { UserSettingsContext } from '../user-settings/UserSettings.types';
import { WorldSettingsFormApplication } from '../world-settings/WorldSettingsFormApplication.svelte';
import type { WorldSettingsContext } from '../world-settings/WorldSettings.types';
import { ThemeSettingsFormApplication } from '../../theme/ThemeSettingsFormApplication.svelte';
import { HomebrewSettingsApplication } from '../../homebrew-settings/HomebrewSettingsApplication.svelte';
import TidyClassicSettings from './TidyClassicSettings.svelte';

export type IntegratedSettingsContext = {
  isGM: boolean;
  userSettings: UserSettingsContext;
  worldSettings?: WorldSettingsContext;
};

/**
 * A single integrated settings window that hosts the existing settings
 * components (user, world, theme, homebrew, tools, about) behind a nav rail.
 *
 * Each hosted pane keeps its own Save/Apply footer. The provider
 * applications are instantiated only for their context builders and save
 * logic; their `close()` is stubbed so a hosted pane's save does not close
 * the host window.
 */
export class TidyClassicSettingsApplication extends SvelteApplicationMixin<
  Partial<ApplicationConfiguration> | undefined,
  IntegratedSettingsContext
>(foundry.applications.api.ApplicationV2) {
  userSettingsProvider = new UserSettingsFormApplication(
    CONSTANTS.TAB_USER_SETTINGS_PLAYERS
  );
  worldSettingsProvider = new WorldSettingsFormApplication();
  themeSettingsProvider = new ThemeSettingsFormApplication();
  homebrewProvider = new HomebrewSettingsApplication();
  private settingsContext?: IntegratedSettingsContext;

  static DEFAULT_OPTIONS: Partial<ApplicationConfiguration> = {
    classes: [
      CONSTANTS.MODULE_ID,
      'settings',
      'application-shell',
      CONSTANTS.SHEET_LAYOUT_CLASSIC,
    ],
    tag: 'div',
    id: 'tidy5e-sheet-integrated-settings',
    window: {
      frame: true,
      positioned: true,
      resizable: true,
      controls: [],
      title: 'TIDY5E.IntegratedSettings.title',
    },
    position: {
      width: 900,
      height: 750,
    },
    actions: {},
    submitOnClose: false,
  };

  constructor(options?: Partial<ApplicationConfiguration> | undefined) {
    super(options);

    for (const provider of [
      this.userSettingsProvider,
      this.worldSettingsProvider,
      this.themeSettingsProvider,
      this.homebrewProvider,
    ]) {
      (provider as any).close = async () => provider;
    }
  }

  async _prepareContext(): Promise<IntegratedSettingsContext> {
    // The Svelte component is mounted only once, while updateSetting can
    // trigger another render. Keep its context and the save providers aligned.
    if (this.settingsContext) {
      return this.settingsContext;
    }

    const isGM = game.user.isGM;

    this.userSettingsProvider.context =
      await this.userSettingsProvider._prepareContext();

    const context: IntegratedSettingsContext = {
      isGM,
      userSettings: this.userSettingsProvider.context!,
    };

    if (isGM) {
      this.worldSettingsProvider.context =
        await this.worldSettingsProvider._prepareContext();
      context.worldSettings = this.worldSettingsProvider.context!;
    }

    this.homebrewProvider._config = this.homebrewProvider._getConfig();

    this.settingsContext = context;
    return this.settingsContext;
  }

  _createComponent(node: HTMLElement): Record<string, any> {
    return mount(TidyClassicSettings, {
      target: node,
      props: {
        app: this,
        context: this._context.data as IntegratedSettingsContext,
        providers: {
          user: this.userSettingsProvider,
          world: this.worldSettingsProvider,
          theme: this.themeSettingsProvider,
          homebrew: this.homebrewProvider,
        },
      },
    });
  }

  _attachFrameListeners() {
    super._attachFrameListeners();

    applyThemeToApplication(this.element);
  }
}
