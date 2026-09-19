import { CONSTANTS } from 'src/constants';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import type { ApplicationConfiguration } from 'src/types/application.types';
import { log } from 'src/utils/logging';

export class ResetSettingsDialog extends foundry.applications.api.DialogV2 {
  /** Delete only this fork's registered world settings, leaving upstream Tidy untouched. */
  static async resetClassicWorldSettings() {
    const prefix = `${CONSTANTS.SETTINGS_NAMESPACE}.${CONSTANTS.SETTINGS_KEY_PREFIX}`;
    const storedSettings = game.settings.storage.get('world').filter(
      (setting: any) =>
        setting.key.startsWith(prefix) &&
        game.settings.settings.get(setting.key)?.scope === 'world'
    );

    for (const setting of storedSettings) {
      log(`Reset setting '${setting.key}'`);
      await setting.delete();
    }
  }

  static DEFAULT_OPTIONS = {
    window: {
      icon: 'fa-solid fa-coins',
      title: 'TIDY5E.Settings.Reset.dialogs.title',
    },
    position: { width: 400 },
    buttons: [
      {
        action: 'yes',
        label: 'TIDY5E.Settings.Reset.dialogs.confirm',
        icon: 'fa-solid fa-check',
        callback: () => ResetSettingsDialog.resetClassicWorldSettings(),
      },
      {
        action: 'no',
        label: 'TIDY5E.Settings.Reset.dialogs.cancel',
        icon: 'fa-solid fa-xmark',
        default: true,
      },
    ],
  };

  _initializeApplicationOptions(options: Partial<ApplicationConfiguration>) {
    options = super._initializeApplicationOptions(options);

    options.content = `<p style="margin-bottom:1rem;">
      ${FoundryAdapter.localize('TIDY5E.Settings.Reset.dialogs.content')}
    </p>`;

    return options;
  }

  async _reset() {
    await ResetSettingsDialog.resetClassicWorldSettings();
  }
}
