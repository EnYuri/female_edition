/**
 * Mirror the small part of Tidy's public registration API that Classic can render.
 * The installed Tidy module keeps its own API object and fires its ready hook once.
 * Its ready hook listeners see these wrappers because Tidy assigns module.api before
 * calling tidy5e-sheet.ready. No Foundry hook or third-party callback is replaced.
 */
export const CLASSIC_HEADER_REGISTRATIONS = Object.freeze([
  'registerActorHeaderControls',
  'registerCharacterHeaderControls',
  'registerEncounterHeaderControls',
  'registerGroupHeaderControls',
  'registerItemHeaderControls',
  'registerNpcHeaderControls',
  'registerVehicleHeaderControls',
]);

/**
 * Custom content is duck-typed on both APIs, so a content object built from the
 * official module's own models (e.g. Plutonium's level-up button) maps cleanly
 * through Classic's mapToRegisteredContents. The layout option still decides
 * which Classic runtimes receive it; 'quadrone'-only content is ignored here.
 */
export const CLASSIC_CONTENT_REGISTRATIONS = Object.freeze([
  'registerActorContent',
  'registerCharacterContent',
  'registerEncounterContent',
  'registerGroupContent',
  'registerItemContent',
  'registerNpcContent',
  'registerVehicleContent',
]);

const wrappedApis = new WeakSet();

function mirrorRegistration(owner, name, classicOwner, warn) {
  const original = owner?.[name];
  const classic = classicOwner?.[name];
  if (typeof original !== 'function' || typeof classic !== 'function') return;

  try {
    owner[name] = function (...args) {
      // The official registration must retain its receiver, arguments and return value.
      const result = original.apply(this, args);
      try { classic.apply(classicOwner, args); }
      catch (error) { warn(`female_edition | Classic API mirror: ${name}`, error); }
      return result;
    };
  } catch (error) {
    warn(`female_edition | cannot mirror Tidy API method: ${name}`, error);
  }
}

/** @param {object} officialApi @param {object} classicApi @param {Function} warn */
export function mirrorTidyRegistrations(officialApi, classicApi, warn = console.warn) {
  if (!officialApi || wrappedApis.has(officialApi)) return;
  wrappedApis.add(officialApi);

  for (const name of CLASSIC_HEADER_REGISTRATIONS) {
    mirrorRegistration(officialApi, name, classicApi, warn);
  }

  for (const name of CLASSIC_CONTENT_REGISTRATIONS) {
    mirrorRegistration(officialApi, name, classicApi, warn);
  }

  // Both versions render section commands on actor-owned item lists. Tidy 14 exposes
  // this on config.actorItem; the fork retains the same method and legacy alias.
  const officialActorItem = officialApi.config?.actorItem;
  const classicActorItem = classicApi.config?.actorItem;
  mirrorRegistration(officialActorItem, 'registerSectionCommands', classicActorItem, warn);
  mirrorRegistration(officialActorItem, 'registerSectionFooterCommands', classicActorItem, warn);
}

/**
 * Install before Foundry's ready hook. The property trap runs synchronously between
 * official Tidy's `module.api = api` and its `tidy5e-sheet.ready` call.
 */
export function installTidyApiBridge(tidyModule, classicApi, warn = console.warn) {
  if (!tidyModule?.active || !classicApi) return false;
  const descriptor = Object.getOwnPropertyDescriptor(tidyModule, 'api');
  if (descriptor && !descriptor.configurable) {
    warn('female_edition | cannot mirror Tidy API: module.api is not configurable');
    return false;
  }
  if (descriptor?.get || descriptor?.set) {
    warn('female_edition | cannot mirror Tidy API: module.api is already an accessor');
    return false;
  }

  let officialApi = descriptor?.value;
  if (officialApi) mirrorTidyRegistrations(officialApi, classicApi, warn);
  try {
    Object.defineProperty(tidyModule, 'api', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() { return officialApi; },
      set(api) {
        officialApi = api;
        try { mirrorTidyRegistrations(api, classicApi, warn); }
        catch (error) { warn('female_edition | cannot mirror Tidy API', error); }
      },
    });
    return true;
  } catch (error) {
    warn('female_edition | cannot install Tidy API mirror', error);
    return false;
  }
}
