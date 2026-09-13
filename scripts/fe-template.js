// female_edition: shared Handlebars template registry.
//
// Markup that used to live as `innerHTML` template literals inside feature scripts is
// authored in `templates/*.hbs` instead, and rendered from here. No imports on purpose
// (the literal module id, like `fe-theatre.js`) so ANY script can use this without
// widening the dependency graph or risking a circular import.
//
// Why a SYNCHRONOUS renderer: nearly every injection site is a synchronous hook
// (`renderChatLog`, a click handler, a `_onRender`). Core's `renderTemplate` is async,
// so awaiting it inside those would reorder DOM work. Instead every path registered
// here is preloaded at `init` — core's `getTemplate` compiles it and registers it as a
// Handlebars partial keyed by its path (`client/applications/handlebars.mjs:42`), so
// after the preload the compiled delegate is available synchronously.
//
// Timing is safe: `init` fires at the very top of `Game#initialize` (`game.mjs:652`),
// while the earliest DOM injection is `initializeUI()` (`game.mjs:764`) — a long await
// chain later. `feRenderTemplate` still degrades to `""` (plus a console warning) if a
// path was never registered, rather than throwing inside a hook.

const FE_TEMPLATE_MODULE_ID = "female_edition";

/** Paths registered for preload, in registration order. @type {Set<string>} */
const FE_TEMPLATE_PATHS = new Set();

/** Resolves once the `init` preload has settled. */
let _feTemplatesResolve;
/** @type {Promise<void>} */
const _feTemplatesReady = new Promise((resolve) => { _feTemplatesResolve = resolve; });

/**
 * Build the web-accessible path of one of this module's templates.
 * @param {string} name  File name inside `templates/` (e.g. `"fe-chat-edit-panel.hbs"`).
 * @returns {string}
 */
export function feTemplatePath(name) {
  return `modules/${FE_TEMPLATE_MODULE_ID}/templates/${name}`;
}

/**
 * Declare templates that must be compiled before any synchronous render.
 * Call at module scope — every script is imported before `init` fires.
 * @param {...string} names  File names inside `templates/`.
 * @returns {string[]} The full paths, in the order given.
 */
export function feRegisterTemplates(...names) {
  const paths = names.map(feTemplatePath);
  for (const path of paths) FE_TEMPLATE_PATHS.add(path);
  return paths;
}

/**
 * Render a preloaded template synchronously.
 * @param {string} path  A path returned by {@link feRegisterTemplates}/{@link feTemplatePath}.
 * @param {object} [data]  Handlebars context.
 * @returns {string} Rendered HTML, or `""` when the template is not compiled yet.
 */
export function feRenderTemplate(path, data = {}) {
  const compiled = globalThis.Handlebars?.partials?.[path];
  if (typeof compiled === "function") return compiled(data);
  // A string partial can happen if something registered it raw; compile once and reuse.
  if (typeof compiled === "string") {
    const fn = globalThis.Handlebars.compile(compiled, { preventIndent: true });
    globalThis.Handlebars.registerPartial(path, fn);
    return fn(data);
  }
  console.warn(`${FE_TEMPLATE_MODULE_ID} | template not preloaded: ${path}`);
  return "";
}

/**
 * Render a preloaded template and return its nodes, ready to append.
 * @param {string} path
 * @param {object} [data]
 * @returns {DocumentFragment}
 */
export function feRenderTemplateFragment(path, data = {}) {
  const tpl = document.createElement("template");
  tpl.innerHTML = feRenderTemplate(path, data);
  return tpl.content;
}

/** @returns {Promise<void>} Resolves once registered templates are compiled. */
export function feTemplatesReady() {
  return _feTemplatesReady;
}

Hooks.once("init", () => {
  const load = foundry.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
  const paths = [...FE_TEMPLATE_PATHS];
  if (!load || !paths.length) return _feTemplatesResolve();
  Promise.resolve(load(paths))
    .catch((err) => console.error(`${FE_TEMPLATE_MODULE_ID} | template preload failed`, err))
    .finally(() => _feTemplatesResolve());
});
