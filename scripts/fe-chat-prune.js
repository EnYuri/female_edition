// fe-chat-prune.js
// DOM pruning subclass for ChatLog.
// Imported by fe-chat-enhance.js; NOT listed in module.json.
//
// Replaces CONFIG.ui.chat with a subclass that:
//   - Prunes oldest messages from DOM once rendered count >= PRUNE_MAX_MESSAGES
//   - Re-renders older messages on demand when the user scrolls to the top
//   - Re-renders newer messages when the user scrolls back to the bottom
//   - Skips installation when the chatlog-prune companion module is already active

import { MODULE_ID, S } from "./fe-constants.js";
import { feApplyChatMergeAroundElement } from "./fe-merge.js";
import { feSnapshotAndRestoreStickyScroll } from "./fe-util.js";

export function feInstallChatLogPrune() {
  // chatlog-prune module handles this already — don't double-install
  if (game.modules.get("chatlog-prune")?.active) {
    console.log("female_edition | chatlog-prune active — skipping built-in DOM pruning");
    return;
  }

  let enabled;
  try { enabled = game.settings.get(MODULE_ID, S.PRUNE_ENABLED); }
  catch { enabled = true; }
  if (!enabled) return;

  // Maximum messages to keep in DOM at one time (read dynamically so live setting changes apply)
  const maxMessages = () => {
    try { return Math.max(20, Number(game.settings.get(MODULE_ID, S.PRUNE_MAX_MESSAGES)) || 50); }
    catch { return 50; }
  };
  // Batch size = half of max (messages loaded per scroll, and post-prune DOM target)
  const bs = () => Math.max(10, Math.floor(maxMessages() / 2));

  const BaseChatLog = CONFIG.ui.chat;

  class FeChatLogPrune extends BaseChatLog {
    // Oldest message ID currently in DOM (undefined = not yet initialised)
    #firstId;
    // Newest message ID currently in DOM
    #newestId;
    // Set of IDs currently rendered in this instance
    #renderedIds = new Set();
    // True when newer messages have been pruned from DOM tail
    #fwdPruned = false;
    // Guards: prevent queuing more than one concurrent render task per direction
    #busyBack = false;
    #busyFwd  = false;
    // Semaphore: backward and forward renders do not interleave
    #sem = new foundry.utils.Semaphore(1);

    // Per-instance debounced helpers (arrow functions capture `this` at construction)
    #schedPruneOld = foundry.utils.debounce(() => this.#pruneOldest(), 100);
    #schedPruneNew = foundry.utils.debounce(() => this.#pruneNewest(), 100);
    #schedOverflow = foundry.utils.debounce(() => this.#updateOverflowClass(), 100);

    // ── Public overrides ────────────────────────────────────────────────────

    async scrollBottom(opts = {}) {
      if (!this.rendered) return;
      // Record newest rendered ID before delegating to Foundry
      const last = this.element?.querySelector(".chat-log")?.lastElementChild;
      if (last?.dataset?.messageId) {
        this.#newestId = last.dataset.messageId;
        this.#renderedIds.add(last.dataset.messageId);
      }
      this.#fwdPruned = false;
      this.#schedPruneOld();
      return super.scrollBottom(opts);
    }

    // Fully replace Foundry's renderBatch so we control #firstId ourselves
    async renderBatch(count) {
      if (this.#busyBack) return;
      this.#busyBack = true;
      await this.#sem.add(() => this.#doRenderBatch(count ?? bs()));
    }

    // Load newer messages after back-pruning
    async renderBatchForward(count) {
      if (this.#busyFwd) return;
      this.#busyFwd = true;
      await this.#sem.add(() => this.#doRenderBatchFwd(count ?? bs()));
    }

    // Guard against updates for messages that are currently pruned from DOM
    async updateMessage(message, options = {}) {
      if (!this.element) return;
      return super.updateMessage(message, options);
    }

    // Extend the scroll listener to trigger forward re-render when at the bottom
    // after the tail was pruned
    _attachLogListeners(scrollEl, opts) {
      super._attachLogListeners(scrollEl, opts);
      let fwdThrottle = false;
      scrollEl.addEventListener("scroll", () => {
        if (!this.rendered || fwdThrottle) return;
        if (!this.element?.querySelector(".chat-log")) return;
        const pct = scrollEl.scrollTop / (scrollEl.scrollHeight - scrollEl.clientHeight);
        if ((pct > 0.99 || isNaN(pct)) && this.#fwdPruned && this.#hasForwardMessages()) {
          fwdThrottle = true;
          this.renderBatchForward(bs())
            .then(() => setTimeout(() => { fwdThrottle = false; }, 100));
        }
      }, { passive: true });
    }

    async close(opts = {}) {
      this.#renderedIds.clear();
      this.#firstId  = undefined;
      this.#newestId = undefined;
      this.#fwdPruned = false;
      return super.close(opts);
    }

    // ── Private: prune helpers ───────────────────────────────────────────────

    // Remove oldest messages from DOM front until count < maxMessages.
    // After pruning, the new first element may have stale merge classes (it was
    // previously fe-merge-mid/end); fix them immediately via the neighborhood pass.
    #pruneOldest() {
      const log = this.element?.querySelector(".chat-log");
      if (!log) return;
      const max = maxMessages();
      if (log.children.length < max) return;
      // Removing/reclassifying changes scrollHeight — wrap so the at-bottom state
      // (auto-scroll) is reasserted afterward, per the module sticky-scroll contract.
      const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
      try {
        while (log.children.length >= max) {
          const el = log.firstElementChild;
          const id = el?.dataset?.messageId;
          if (!id) break;
          this.#renderedIds.delete(id);
          if (!this.isPopout) {
            const msg = game.messages?.get(id);
            if (msg) msg.logged = false;
          }
          el.remove();
        }
        this.#firstId = log.firstElementChild?.dataset?.messageId;
        // The new boundary element may have stale fe-merge-* classes — reclassify it
        const newFirst = log.firstElementChild;
        if (newFirst) {
          try { feApplyChatMergeAroundElement(newFirst, { skipDedup: true }); } catch { /* no-op */ }
        }
      } finally {
        restoreStickyScroll();
      }
      this.#schedOverflow();
    }

    // Remove newest messages from DOM tail after loading older messages.
    // Sets #fwdPruned so the forward scroll listener knows to re-render them.
    // After pruning, the new last element may have stale merge classes — fix them.
    #pruneNewest() {
      const log = this.element?.querySelector(".chat-log");
      if (!log) return;
      const batchTarget = bs();
      if (log.children.length < maxMessages()) return;
      // This runs while scrolled up (not at bottom), so the snapshot will read
      // atBottom=false and leave scroll position untouched — but wrap anyway so
      // the rare at-bottom case (large batch fills) stays pinned.
      const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
      let pruned = 0;
      try {
        while (log.children.length > batchTarget) {
          const el = log.lastElementChild;
          if (!el) break;
          // Only prune real chat messages. Other modules (e.g. typing indicators)
          // inject into .chat-form, not .chat-log, but guard defensively: if a
          // non-message element is ever the tail, stop rather than removing it.
          if (!el.matches?.("li.chat-message") || !el.dataset?.messageId) break;
          const id = el.dataset.messageId;
          this.#renderedIds.delete(id);
          if (!this.isPopout) {
            const msg = game.messages?.get(id);
            if (msg) msg.logged = false;
          }
          el.remove();
          pruned++;
        }
        if (pruned > 0) {
          this.#newestId = log.lastElementChild?.dataset?.messageId;
          this.#fwdPruned = true;
          // The new boundary element may have stale fe-merge-* classes — reclassify it
          const newLast = log.lastElementChild;
          if (newLast) {
            try { feApplyChatMergeAroundElement(newLast, { skipDedup: true }); } catch { /* no-op */ }
          }
        }
      } finally {
        restoreStickyScroll();
      }
      this.#schedOverflow();
    }

    // ── Private: render batch (backward) ────────────────────────────────────

    async #doRenderBatch(count) {
      try {
        if (!this.rendered) return;
        const all = game.messages?.contents;
        const log = this.element?.querySelector(".chat-log");
        if (!all || !log) return;

        // Recover #firstId from DOM if the tracked message was deleted or is missing.
        // Without this guard, findIndex returns -1 → end = messages.length → we'd
        // reload from the newest end and lose the user's scroll position.
        if (this.#firstId && !log.querySelector(`[data-message-id="${this.#firstId}"]`)) {
          this.#firstId = log.firstElementChild?.dataset?.messageId;
        }

        // Find where we last stopped; unknown → start from the newest end (initial populate)
        let end = all.findIndex(m => m.id === this.#firstId);
        if (end === -1) end = all.length;
        if (end === 0) return;

        // Walk backwards to collect up to `count` visible, un-rendered messages
        let start = end;
        let visible = 0;
        const scanLimit = count * 10;
        let scanned = 0;
        while (start > 0 && visible < count && scanned < scanLimit) {
          start--;
          scanned++;
          const m = all[start];
          if (m.visible && !this.#renderedIds.has(m.id)) visible++;
        }

        const fragments = [];
        for (let i = start; i < end; i++) {
          const msg = all[i];
          if (!msg.visible || this.#renderedIds.has(msg.id)) continue;
          this.#renderedIds.add(msg.id);
          if (!this.isPopout) msg.logged = true;
          try {
            fragments.push(await this.constructor.renderMessage(msg));
          } catch (err) {
            Hooks.onError("FeChatLogPrune.renderBatch", err, {
              msg: `Chat message ${msg.id} failed to render`, log: "error",
            });
          }
        }

        if (fragments.length) {
          log.prepend(...fragments);
          this.#firstId = all[start]?.id ?? this.#firstId;
        }

        // We just loaded older messages — prune the newest tail to stay bounded
        this.#schedPruneNew();
        this.#schedOverflow();
      } finally {
        this.#busyBack = false;
      }
    }

    // ── Private: render batch (forward) ─────────────────────────────────────

    async #doRenderBatchFwd(count) {
      try {
        if (!this.rendered) return;
        const all = game.messages?.contents;
        const log = this.element?.querySelector(".chat-log");
        if (!all?.length || !log) return;

        // Recover #newestId from DOM if the tracked message was deleted or is missing
        if (this.#newestId && !log.querySelector(`[data-message-id="${this.#newestId}"]`)) {
          this.#newestId = log.lastElementChild?.dataset?.messageId;
        }

        let idx = all.findIndex(m => m.id === this.#newestId);
        if (idx === -1) return;
        idx++; // start after current newest
        if (idx >= all.length) { this.#fwdPruned = false; return; }

        const fragments = [];
        let lastIdx = idx - 1;
        let visible = 0;
        for (let i = idx; i < all.length && visible < count; i++) {
          const msg = all[i];
          if (!msg.visible || this.#renderedIds.has(msg.id)) continue;
          this.#renderedIds.add(msg.id);
          if (!this.isPopout) msg.logged = true;
          lastIdx = i;
          visible++;
          try {
            fragments.push(await this.constructor.renderMessage(msg));
          } catch (err) {
            Hooks.onError("FeChatLogPrune.renderBatchForward", err, {
              msg: `Chat message ${msg.id} failed to render`, log: "error",
            });
          }
        }

        if (fragments.length) {
          log.append(...fragments);
          this.#newestId = all[lastIdx]?.id ?? this.#newestId;
        }
        // Loaded newer messages — prune oldest end to stay bounded
        this.#schedPruneOld();
        this.#schedOverflow();
      } finally {
        this.#busyFwd = false;
      }
    }

    // ── Private: utilities ───────────────────────────────────────────────────

    // True when there are visible messages after #newestId that are not in DOM
    #hasForwardMessages() {
      if (!this.#newestId) return false;
      const all = game.messages?.contents;
      if (!all?.length) return false;
      const idx = all.findIndex(m => m.id === this.#newestId);
      if (idx === -1) return false;
      for (let i = idx + 1; i < all.length; i++) {
        if (all[i].visible) return true;
      }
      return false;
    }

    #updateOverflowClass() {
      try {
        const scrollEl = this.element?.querySelector(".chat-scroll");
        if (scrollEl) {
          scrollEl.classList.toggle("overflowed", scrollEl.scrollHeight > scrollEl.offsetHeight);
        }
      } catch { /* no-op */ }
    }
  }

  CONFIG.ui.chat = FeChatLogPrune;
  console.log(`female_edition | DOM pruning enabled (extending ${BaseChatLog.name})`);
}
