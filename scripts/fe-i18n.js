// Resolve at use time: modules and static settings data load before i18n is ready.
export function feLocalize(key) {
  return globalThis.game?.i18n?.localize(key) ?? key;
}

export function feFormat(key, data) {
  return globalThis.game?.i18n?.format(key, data) ?? key;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

export function feLocalizeHTML(key) {
  return escapeHTML(feLocalize(key));
}

export function feFormatHTML(key, data) {
  return escapeHTML(feFormat(key, data));
}
