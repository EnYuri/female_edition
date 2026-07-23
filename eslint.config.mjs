// Dev-only ESLint config (flat). NOT shipped to Foundry users — export-ignore'd
// in .gitattributes. Foundry serves scripts/ directly with no build step, so this
// exists purely to catch real mistakes (typos, unreachable code, duplicate keys,
// accidental globals) in a ~31k-line ES-module codebase — NOT to enforce style.
//
// Run:  npm run lint
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["scripts/**/*.js", "ci/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
        // Foundry VTT core globals (subset actually referenced by this module).
        game: "readonly",
        ui: "readonly",
        canvas: "readonly",
        Hooks: "readonly",
        CONFIG: "readonly",
        CONST: "readonly",
        foundry: "readonly",
        PIXI: "readonly",
        Handlebars: "readonly",
        socketlib: "readonly",
        // Document / application classes commonly used unqualified.
        Actor: "readonly",
        Item: "readonly",
        ChatMessage: "readonly",
        User: "readonly",
        Scene: "readonly",
        Roll: "readonly",
        Dialog: "readonly",
        Application: "readonly",
        FormApplication: "readonly",
        FilePicker: "readonly",
        TextEditor: "readonly",
        Tile: "readonly",
        Token: "readonly",
        TokenDocument: "readonly",
        Combat: "readonly",
        Combatant: "readonly",
        Playlist: "readonly",
        PlaylistSound: "readonly",
        // Global utility functions Foundry exposes.
        fromUuid: "readonly",
        fromUuidSync: "readonly",
        getDocumentClass: "readonly",
        loadTemplates: "readonly",
        renderTemplate: "readonly",
        isNewerVersion: "readonly",
        randomID: "readonly",
        mergeObject: "readonly",
        duplicate: "readonly",
        // Foundry exposes jQuery globally; some sheets receive a jQuery handle.
        jQuery: "readonly",
        FormDataExtended: "readonly",
        // Optional third-party module globals this module integrates with.
        libWrapper: "readonly",
        ForceClientSettings: "readonly",
        // Companion system global API (double-cross-3rd / dx3rd-emanim).
        DX3rd: "readonly",
        Theatre: "readonly",
      },
    },
    rules: {
      // This codebase deliberately keeps unused catch bindings and some
      // scaffolding args; keep unused-vars as a non-blocking warning and allow
      // the `_`-prefix / bare-catch escape hatches it already uses.
      "no-unused-vars": [
        "warn",
        {
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Empty blocks are idiomatic here as defensive DOM guards (`catch {}`);
      // allow empty catch specifically, still flag other empty blocks.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // Escaping `-` in a character class (`[..\-]`) is a defensible defensive
      // habit here, not a mistake — don't flag it.
      "no-useless-escape": "off",
      // A literal non-breaking space is legitimately matched/replaced inside
      // regexes and lives in Korean strings/comments; only flag stray NBSP in
      // actual code.
      "no-irregular-whitespace": [
        "error",
        { skipStrings: true, skipComments: true, skipTemplates: true, skipRegExps: true },
      ],
      // Real-bug rules stay as errors (these are what the linter is FOR).
      "no-cond-assign": ["error", "always"],
      "no-dupe-keys": "error",
      "no-dupe-args": "error",
      "no-unreachable": "error",
      "no-self-assign": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
];
