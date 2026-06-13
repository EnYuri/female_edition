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

import "./chat-bg-stripper.js";
import "./fe-chat-enhance.js";

// ALL module settings are config: false — managed exclusively through the unified
// settings panel (fe-settings-menu.js). This includes the once-standalone features
// (fe-chat-images / fe-image-hover / fe-narrator / fe-theatre / fe-screen-panel),
// whose settings were migrated into the unified menu (no native Module Settings
// entries). Their modules still READ via game.settings.get; the menu writes them.
// CLIENT-scope personal ones are listed in FE_GM_PRIORITY_EXCLUDED_KEYS so the
// menu reflects each client's own value (no GM-priority override staleness).

// Feature splits
import "./fe-chat-edit.js";
import "./fe-chat-archive.js";
import "./fe-tidy-override.js";
import "./fe-chat-portrait.js";
import "./fe-chat-images.js";

// Data injections
import "./inject-conditions.js";
import "./inject-damage-type.js";
import "./fe-scene-controls-collapse.js";
