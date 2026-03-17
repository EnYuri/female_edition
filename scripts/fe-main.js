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

// Settings are exposed directly in Foundry's standard Module Settings UI (config: true)
// so that tools like Force Client Settings can lock/sync client settings.
// The previous custom popup settings menu is intentionally not loaded.

// Feature splits
import "./fe-chat-edit.js";
import "./fe-chat-archive.js";
import "./fe-tidy-override.js";
import "./fe-chat-portrait.js";
import "./fe-chat-images.js";

// Data injections
import "./inject-conditions.js";
import "./inject-damage-type.js";
