// Female-cupwhi entrypoint
// Loads feature modules in a controlled order.

import "./chat-bg-stripper.js";
import "./fe-chat-enhance.js";

// Settings UI (collapsible, grouped)
import "./fe-settings-menu.js";

// Feature splits
import "./fe-chat-edit.js";
import "./fe-chat-archive.js";
import "./fe-tidy-override.js";
import "./fe-chat-portrait.js";

// Data injections
import "./inject-conditions.js";
import "./inject-damage-type.js";
