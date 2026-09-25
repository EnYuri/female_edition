const inputTagNames = new Set([
  'INPUT',
  'BUTTON',
  'SELECT',
  'COLOR',
  'DATE',
  'DATETIME-LOCAL',
  'EMAIL',
  'FILE',
  'HIDDEN',
  'A',
]);
const inputTabNamesSelector = Array.from(inputTagNames)
  .map((i) => i.toLowerCase())
  .join(', ');

/**
 * Determines whether an HTML element is known to be user interactable—e.g., the user can click, input, or otherwise interact with the element.
 * @param el the element to evaluate
 * @returns whether the element is a standard user-interactable element
 */
export function isUserInteractable(el: HTMLElement) {
  return (
    // Is it one of the known interactables?
    inputTagNames.has(el.tagName) ||
    // Is it contained within an interactable?
    el.closest(inputTabNamesSelector)
  );
}

/**
 * Finds the ID of the tab that contains the given element.
 * @param element the element to evaluate
 * @returns the ID of the containing tab, if found
 */
export function getTabIdFromElement(element: HTMLElement | null | undefined) {
  const tabDataEl = element?.closest<HTMLElement>(
    '[data-tab-contents-for], [data-tab-id]'
  );

  return (
    tabDataEl?.getAttribute('data-tab-contents-for') ??
    tabDataEl?.getAttribute('data-tab-id') ??
    null
  );
}

/**
 * Finds the ID of the tab that the given event occurred in.
 * @param event the event to evaluate
 * @returns the ID of the containing tab, if found
 */
export function getTabIdFromEvent(event: Event) {
  // svelte likes to eschew event.target, but we need it here
  return getTabIdFromElement(
    (event as Event & { target: HTMLElement }).target
  );
}
