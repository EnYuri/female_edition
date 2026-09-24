import { FoundryAdapter } from './foundry/foundry-adapter';
import { Tidy5eCharacterSheet } from './sheets/classic/Tidy5eCharacterSheet.svelte';
// Upstream imported `./less/tidy5e.less` here. The LESS sources are NOT recoverable —
// only the JS sourcemap ships `sourcesContent`, and the stylesheet had no map — so the
// compiled output lives in `styles/tidy5e-classic-global.css` and is registered through
// female_edition's module.json instead of being pulled in through this bundle.
import {
  SettingsProvider,
  initSettings,
  settings,
} from './settings/settings.svelte';
import { Tidy5eItemSheetClassic } from './sheets/classic/Tidy5eItemSheetClassic.svelte';
import { Tidy5eNpcSheet } from './sheets/classic/Tidy5eNpcSheet.svelte';
import { Tidy5eVehicleSheet } from './sheets/classic/Tidy5eKgarVehicleSheet.svelte';
import { CONSTANTS } from './constants';
import { Tidy5eSheetsApi } from './api/Tidy5eSheetsApi';
import '../public/rpg-awesome/style/rpg-awesome.min.css';
import { initRuntimeOnReady, initRuntime } from './runtime/runtime-init';
import { setupIntegrations } from './integration/integration';
import { TidyHooks } from './foundry/TidyHooks';
import { initKeybindings } from './keybindings/keybind-init';
import { Tidy5eGroupSheetClassic } from './sheets/classic/Tidy5eGroupSheetClassic.svelte';
import { DebugTools } from './utils/DebugTools';
import { Tidy5eContainerSheetClassic } from './sheets/classic/Tidy5eContainerSheetClassic.svelte';
import { initReadyHooks } from './features/ready-hooks';
import '@melloware/coloris/dist/coloris.css';
import { debug } from './utils/logging';
import { Tidy5eEncounterSheetClassic } from './sheets/classic/Tidy5eEncounterSheetClassic.svelte';
import { ThemeQuadrone } from './theme/theme-quadrone.svelte';
import { formatResourcePathForCss } from './utils/path';
import { installTidyApiBridge } from './integration/tidy-api-bridge.js';

/**
 * Classic-only fork of Tidy 5e Sheets 12.5.5.
 *
 * Upstream retired the Classic layout in 14.x (Quadrone-only) and ended support, so
 * female_edition carries it forward. Only the CLASSIC sheets are registered here — the
 * Quadrone registrations that used to live in this file are gone, because the installed
 * tidy5e-sheet 14.x still provides Quadrone and registering a second copy would put two
 * identical entries in every sheet picker.
 *
 * The sheet label is a literal rather than an i18n key: upstream's `TIDY5E.*` keys are
 * also loaded by tidy5e-sheet 14, so reusing them would make our entries indistinguishable
 * from Quadrone's in the picker.
 */
const CLASSIC_SHEET_LABEL = 'Tidy 5e Sheet-Classic';

Hooks.once('init', () => {
  if (game.system.id !== CONSTANTS.DND5E_SYSTEM_ID) return;
  const documentSheetConfig = foundry.applications.apps.DocumentSheetConfig;

  documentSheetConfig.registerSheet(
    Actor,
    CONSTANTS.DND5E_SYSTEM_ID,
    Tidy5eCharacterSheet,
    {
      types: [CONSTANTS.SHEET_TYPE_CHARACTER],
      label: CLASSIC_SHEET_LABEL,
    }
  );

  documentSheetConfig.registerSheet(
    Actor,
    CONSTANTS.DND5E_SYSTEM_ID,
    Tidy5eNpcSheet,
    {
      types: [CONSTANTS.SHEET_TYPE_NPC],
      label: CLASSIC_SHEET_LABEL,
    }
  );

  documentSheetConfig.registerSheet(
    Actor,
    CONSTANTS.DND5E_SYSTEM_ID,
    Tidy5eVehicleSheet,
    {
      types: [CONSTANTS.SHEET_TYPE_VEHICLE],
      label: CLASSIC_SHEET_LABEL,
    }
  );

  const supportedItemTypes = [
    CONSTANTS.ITEM_TYPE_BACKGROUND,
    CONSTANTS.ITEM_TYPE_CLASS,
    CONSTANTS.ITEM_TYPE_CONSUMABLE,
    CONSTANTS.ITEM_TYPE_EQUIPMENT,
    CONSTANTS.ITEM_TYPE_FACILITY,
    CONSTANTS.ITEM_TYPE_FEAT,
    CONSTANTS.ITEM_TYPE_LOOT,
    CONSTANTS.ITEM_TYPE_RACE,
    CONSTANTS.ITEM_TYPE_SPELL,
    CONSTANTS.ITEM_TYPE_SUBCLASS,
    CONSTANTS.ITEM_TYPE_TOOL,
    CONSTANTS.ITEM_TYPE_WEAPON,
  ];

  documentSheetConfig.registerSheet(
    Item,
    CONSTANTS.DND5E_SYSTEM_ID,
    Tidy5eItemSheetClassic,
    {
      types: supportedItemTypes,
      label: CLASSIC_SHEET_LABEL,
    }
  );

  documentSheetConfig.registerSheet(
    Item,
    CONSTANTS.DND5E_SYSTEM_ID,
    Tidy5eContainerSheetClassic,
    {
      types: [CONSTANTS.SHEET_TYPE_CONTAINER],
      label: CLASSIC_SHEET_LABEL,
    }
  );

  documentSheetConfig.registerSheet(
    Actor,
    CONSTANTS.DND5E_SYSTEM_ID,
    Tidy5eGroupSheetClassic,
    {
      types: [CONSTANTS.SHEET_TYPE_GROUP],
      label: CLASSIC_SHEET_LABEL,
    }
  );

  documentSheetConfig.registerSheet(
    Actor,
    CONSTANTS.DND5E_SYSTEM_ID,
    Tidy5eEncounterSheetClassic,
    {
      types: [CONSTANTS.SHEET_TYPE_ENCOUNTER],
      label: CLASSIC_SHEET_LABEL,
    }
  );

  initSettings();
  initRuntime();
  initKeybindings();
  registerCustomTidyRollRequests();
});

Hooks.once('ready', async () => {
  if (game.system.id !== CONSTANTS.DND5E_SYSTEM_ID) return;
  const api = Tidy5eSheetsApi._getApi();
  const femaleEdition = FoundryAdapter.getModule(CONSTANTS.SETTINGS_NAMESPACE);
  femaleEdition.api ??= {};
  femaleEdition.api.tidyClassic = api;

  initRuntimeOnReady();

  // The official Tidy module owns its API and ready hook when active. As a sole
  // provider, Classic keeps the established hook for integrations that use it.
  const upstreamTidy = FoundryAdapter.getModule(CONSTANTS.MODULE_ID);
  if (!upstreamTidy?.active) {
    // In this mode no upstream script can overwrite the compatibility alias.
    // Direct API readers such as Quick Insert can still find the sole provider.
    if (upstreamTidy) upstreamTidy.api = api;
    TidyHooks.tidy5eSheetsReady(api);
  }
  Hooks.callAll('female_edition.tidyClassicReady', api);

  setupIntegrations(api);

  initReadyHooks();

  DebugTools.onReady(api);

  ThemeQuadrone.onReady();

  /* Three GM whispers used to be sent from this hook and all three are gone:
   * a first-run welcome, a "Classic sheets have been removed from Tidy 5e Sheets"
   * notice on Foundry v14, and a migration-available notice headed with
   * `TIDY5E.ModuleName`. Every one of them speaks as Tidy 5e Sheets, which this module
   * is not — and the v14 one announces the removal of the very sheets this fork exists
   * to keep providing. The notifications feature was deleted with them. */
});

Hooks.once('setup', async () => {
  if (game.system.id !== CONSTANTS.DND5E_SYSTEM_ID) return;
  installTidyApiBridge(
    FoundryAdapter.getModule(CONSTANTS.MODULE_ID),
    Tidy5eSheetsApi._getApi()
  );
  const style = document.createElement('style');
  style.id = 'tidy5e-classic-generated-styles';
  document.head.append(style);

  // Note: When popout is added to core, this may need to be changed to use .sheet.insertRule
  style.textContent = Object.entries(CONFIG.DND5E.currencies)
    .map(
      ([key, val]) =>
        `.tidy5e-sheet .currency.${key} { --currency-icon-url: url("${formatResourcePathForCss(
          (val as any).icon
        )}"); }`
    )
    .join('\n\n');
});

function registerCustomTidyRollRequests() {
  // dnd5e's roll-request system is only present on newer versions.
  const requests = (CONFIG.DND5E as any)?.requests;
  if (!requests) {
    return;
  }

  requests[CONSTANTS.ROLL_REQUEST_ABILITY_KEY] ??= async (
    actor: any,
    request: any,
    config: any,
    { event }: { event?: Event } = {}
  ) => {
    const data = {};
    foundry.utils.setProperty(data, 'flags.dnd5e.requestResult', {
      actorUuid: actor.uuid,
      requestId: request.id,
    });
    const [roll] =
      (await actor.rollAbilityCheck({ ...config, event }, {}, { data })) ?? [];
    return roll?.parent ?? null;
  };
}
