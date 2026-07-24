// Female-cupwhi entrypoint — REFERENCE ONLY, NOT LOADED BY module.json
//
// This file is intentionally excluded from the `esmodules` list in module.json.
// Each script is registered individually in module.json so Foundry loads them
// directly as ES modules. Listing fe-main.js in module.json AND having it
// re-import all sibling scripts would cause every script to execute twice,
// doubling hook registrations and settings.
//
// This file is kept as a human-readable load-order reference only.
// DO NOT add fe-main.js to module.json esmodules.

// The import list below mirrors module.json `esmodules` IN LOAD ORDER. Keep it in
// sync when adding/removing an entry there (this file is not executed, so drift
// here has no runtime effect — it is a documentation aid only).

// Chat core
import "./chat-bg-stripper.js";
import "./fe-chat-enhance.js";

// ALL module settings are config: false — managed exclusively through the unified
// settings panel (fe-settings-menu.js). This includes the once-standalone features
// (fe-chat-images / fe-image-hover / fe-narrator / fe-theatre / fe-screen-panel),
// whose settings were migrated into the unified menu (no native Module Settings
// entries). Their modules still READ via game.settings.get; the menu writes them.
// Client-scope settings are GM-forced unless listed in
// FE_GM_PRIORITY_EXCLUDED_KEYS; those excluded keys are the only always-personal
// categories.

// Chat feature splits
import "./fe-chat-edit.js";
import "./fe-chat-archive.js";
import "./fe-tidy-override.js";
import "./fe-chat-portrait.js";
import "./fe-chat-images.js";

// Data injections (dnd5e-guarded)
import "./inject-conditions.js";
import "./inject-damage-type.js";

// dx3rd companion-system compat
import "./fe-dx3rd-resource-ui.js";

// Token / image features
import "./fe-image-hover.js";
import "./fe-theatre.js";

// Chat UI extras
import "./fe-typing-indicator.js";
import "./fe-chat-controls-menu.js";
import "./fe-scene-controls-collapse.js";

// Screen panel + unified settings
import "./fe-screen-panel.js";
import "./fe-settings-menu.js";

// FilePicker enhancements
import "./fe-filepicker-sort.js";
import "./fe-filepicker-preview.js";
import "./fe-playlist-name.js";
import "./fe-dx3rd-input-align.js";

// Narrator + conflict handling
import "./fe-narrator.js";
import "./fe-conflict-guard.js";
import "./fe-attr-path-helper.js";

// Token features
import "./fe-token-preview.js";
import "./fe-token-name-sync.js";
import "./fe-combat-tracker.js";
import "./fe-token-glow.js";

// Fonts / update / music
import "./fe-user-font.js";
import "./fe-update-check.js";
import "./fe-music.js";
