import { hideCatActivityOnActor } from './cat.js';

/** Shortcuts remain saved even when their module excludes an activity from play. */
export function hideActivityShortcut(activity) {
  return hideCatActivityOnActor(activity) ||
    Boolean(activity?.midiProperties?.automationOnly && game.modules.get('midi-qol')?.active);
}
