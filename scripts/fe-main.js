// Female-cupwhi entrypoint
// Loads feature modules in a controlled order.

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

// Data injections
import "./inject-conditions.js";
import "./inject-damage-type.js";
