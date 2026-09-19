import { CONSTANTS } from 'src/constants';
import type { UserPreferences } from './user-preferences.types';
import { FoundryAdapter } from 'src/foundry/foundry-adapter';
import { TidyFlags } from 'src/foundry/TidyFlags';

class UserPreferencesService {
  readonly prop = `flags.${CONSTANTS.MODULE_ID}.userPreferences`;

  async setPreference<
    K extends keyof UserPreferences,
    V extends UserPreferences[K]
  >(property: K, value: V) {
    // Not `game.user.setFlag` — see the scope-validation note in TidyFlags.
    await TidyFlags.setFlag(game.user, `userPreferences.${property}`, value);
  }

  get(): UserPreferences {
    return {
      expandCollapseBehavior: 'top-level',

      ...FoundryAdapter.getProperty<UserPreferences>(game.user, this.prop),
    };
  }
}

export default new UserPreferencesService();
