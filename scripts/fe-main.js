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

// Settings in fe-chat-enhance / chat-bg-stripper / fe-chat-portrait are config: false
// — managed exclusively through the unified settings panel (fe-settings-menu.js).
// fe-chat-images / fe-image-hover / fe-theatre keep config: true (no unified-menu section).

// Feature splits
import "./fe-chat-edit.js";
import "./fe-chat-archive.js";
import "./fe-tidy-override.js";
import "./fe-chat-portrait.js";
import "./fe-chat-images.js";

// Data injections
import "./inject-conditions.js";
import "./inject-damage-type.js";
