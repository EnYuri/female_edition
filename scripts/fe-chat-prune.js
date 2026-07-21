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
import { feIsActiveModuleFeatureEnabled } from "./fe-conflict-state.js";

export function feInstallChatLogPrune() {
  // chatlog-prune module handles this already — don't double-install
  if (feIsActiveModuleFeatureEnabled("chatlog-prune", "enabled", { unknown: true })) {
    console.log("female_edition | chatlog-prune pruning enabled — skipping built-in DOM pruning");
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
    // Last observed scrollTop on the scroll container — used to require a genuine
    // downward gesture before forward-rendering (so a programmatic clamp does not
    // bounce the reader back to live).
    #lastScrollTop = 0;
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

    // True while the user is browsing history: the newest tail is pruned AND the
    // DOM's last child is NOT the true newest message. feSnapshotAndRestoreStickyScroll()
    // reads this to avoid pinning the reader to the (incomplete) DOM bottom.
    // Mirrors the scrollBottom() guard so that once the reader has forward-rendered
    // all the way back to the newest message — even if #fwdPruned lingers true until
    // the next postOne — sticky auto-scroll resumes immediately.
    get isBrowsingHistory() {
      return this.#fwdPruned === true && !this.#domTailIsNewest();
    }

    async scrollBottom(opts = {}) {
      if (!this.rendered) return;
      // CRITICAL: if the newest tail was pruned (#fwdPruned), the DOM's last child
      // is NOT the true newest message. Foundry calls scrollBottom for the
      // jump-to-bottom button, auto-follow on new messages, sticky-scroll restore,
      // etc. Naively scrolling the incomplete DOM (the old behavior) leaves an OLD
      // message stuck at the bottom while the newest is missing — the reported
      // "newest disappears, old message at the bottom" bug. Reconcile by reloading
      // the newest contiguous window so "scroll to bottom" actually shows the latest.
      // (#goLive resets #fwdPruned then calls scrollBottom again → normal path; no recursion.)
      if (this.#fwdPruned && !this.#domTailIsNewest()) {
        await this.#goLive();
        return;
      }
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

    // Guard against updates for messages that are currently pruned from DOM.
    // Core #updateMessage re-posts a message that is NOT in the DOM (e.g. one that
    // just became visible) via #postOne with a `before` id. While the tail is
    // forward-pruned, that `before` element may be absent → base falls back to
    // `log.append`, recreating the same non-contiguous gap as postOne. If the
    // message is already in the DOM this is just an in-place content edit (safe).
    async updateMessage(message, options = {}) {
      if (!this.element) return;
      if (this.#fwdPruned && message?.visible && !this.#domTailIsNewest()) {
        const inDom = this.element.querySelector(`.chat-log [data-message-id="${message.id}"]`);
        if (!inDom) return; // skip the gap-creating re-post; forward-scroll renders it in order
      }
      return super.updateMessage(message, options);
    }

    // Post a single new message. CRITICAL ordering guard.
    //
    // When the newest tail has been pruned from the DOM (user scrolled up →
    // #pruneNewest set #fwdPruned, #newestId = M = some OLD boundary message),
    // the DOM no longer contains the true latest messages. Foundry's base
    // #postOne places an incoming message by timestamp relative to the DOM
    // children: since the DOM tail M is older than the new message, it appends
    // the new message right after M. That leaves the DOM NON-CONTIGUOUS — there
    // is now a gap between M and the freshly-appended newest message.
    //
    // The forward-render path (#doRenderBatchFwd) assumes a contiguous
    // [#firstId .. #newestId] window: it walks game.messages forward from
    // #newestId (= M) and `log.append`s the in-between messages to the bottom.
    // Because the new message already sits at the bottom (and was never recorded
    // in #renderedIds), those older in-between messages get appended BELOW it and
    // the new message is rendered a SECOND time → old-below-new reordering and
    // duplicates. This is the "chat shuffling" regression.
    //
    // Fix: never let a new message land after the pruned boundary. If the user is
    // following the bottom (or it's their own message), rebuild the newest
    // contiguous window (#goLive). Otherwise keep their scrolled-up window intact
    // and let the forward-render path render the message in order when they scroll
    // down — only surfacing the unread notification now.
    async postOne(message, options = {}) {
      try {
        if (this.#fwdPruned && message?.visible) {
          if (this.#domTailIsNewest()) {
            // Flag was stale (DOM tail is already the newest) — safe to append.
            this.#fwdPruned = false;
          } else {
            const follow = this.isAtBottom || (message?.author?.id === game.user?.id);
            if (follow) {
              await this.#goLive();
            } else {
              try { this.notify(message, { newMessage: true }); } catch { /* no-op */ }
              if (this.popout?.rendered) {
                try { this.popout.postOne(message, { ...options, notify: false }); } catch { /* no-op */ }
              }
            }
            return;
          }
        }
        return super.postOne(message, options);
      } catch (err) {
        Hooks.onError?.("FeChatLogPrune.postOne", err, { msg: `Chat message ${message?.id} failed to post`, log: "error" });
        try { return super.postOne(message, options); } catch { /* no-op */ }
      }
    }

    // Extend the scroll listener to trigger forward re-render when at the bottom
    // after the tail was pruned
    _attachLogListeners(scrollEl, opts) {
      super._attachLogListeners(scrollEl, opts);
      let fwdThrottle = false;
      scrollEl.addEventListener("scroll", () => {
        if (!this.rendered || fwdThrottle) return;
        if (!this.element?.querySelector(".chat-log")) return;
        const prevTop = this.#lastScrollTop;
        const curTop = scrollEl.scrollTop;
        this.#lastScrollTop = curTop;
        const denom = scrollEl.scrollHeight - scrollEl.clientHeight;
        const pct = curTop / denom;
        // Only forward-render on a GENUINE downward scroll that reaches the bottom.
        // Excluding the isNaN/at-bottom auto-trigger (and requiring curTop >= prevTop)
        // prevents the programmatic scrollTop clamp left by #pruneNewest from
        // instantly bouncing the reader back to the newest message. To go live from
        // a window that fully fits on screen (denom === 0), the jump-to-bottom button
        // calls scrollBottom() → #goLive().
        const reachedBottom = denom > 0 && pct > 0.99 && curTop >= prevTop;
        if (reachedBottom && this.#fwdPruned && this.#hasForwardMessages()) {
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
      const scrollEl = this.element?.querySelector(".chat-scroll") ?? log;
      // CRITICAL: only prune tail messages that sit fully BELOW the viewport (plus
      // one screen of buffer). Pruning a message the user is currently looking at
      // collapses the scroll region under them — the browser then clamps scrollTop
      // and snaps them to the newest message (history browsing becomes impossible),
      // and any forced repositioning to compensate makes the view jump. By keeping
      // everything visible+buffer intact, scrollTop stays valid and the reader does
      // not move at all. The kept tail messages become prunable later, once the user
      // scrolls further up and pushes them off-screen.
      const scrollRect = scrollEl.getBoundingClientRect();
      const keepBelowPx = scrollEl.clientHeight; // one viewport of look-ahead buffer
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
          // Stop as soon as the tail element is within the viewport (or its buffer):
          // elTop is the element's top relative to the scroll container's visible top;
          // clientHeight is the bottom of the viewport. Removing below this is safe.
          const elTop = el.getBoundingClientRect().top - scrollRect.top;
          if (elTop <= scrollEl.clientHeight + keepBelowPx) break;
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
            const el = await this.constructor.renderMessage(msg);
            this.#stampMessageOrder(el, i);
            fragments.push(el);
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
            const el = await this.constructor.renderMessage(msg);
            this.#stampMessageOrder(el, i);
            fragments.push(el);
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

    // True when the DOM's last chat message is the newest visible message overall
    // — i.e. there is NO forward gap, so a normal tail-append is safe. Used to
    // detect a stale #fwdPruned flag in postOne.
    #domTailIsNewest() {
      try {
        const log = this.element?.querySelector(".chat-log");
        const lastId = log?.lastElementChild?.dataset?.messageId;
        if (!lastId) return false;
        const all = game.messages?.contents;
        if (!all?.length) return false;
        for (let i = all.length - 1; i >= 0; i--) {
          if (all[i].visible) return all[i].id === lastId;
        }
        return false;
      } catch { return false; }
    }

    // Discard the current (scrolled-up) window and repopulate from the newest end,
    // then pin to the bottom. Used when a new message arrives while the tail is
    // forward-pruned and the user is following live (at bottom / own message), so
    // the message is shown in correct order without recreating a non-contiguous gap.
    async #goLive() {
      try {
        const log = this.element?.querySelector(".chat-log");
        if (!log) return;
        // Bypass the per-direction busy guards (we are intentionally re-seeding).
        this.#busyBack = false;
        this.#busyFwd  = false;
        // Reset state + clear + repopulate atomically inside the render semaphore so
        // it cannot interleave with a concurrent backward/forward batch render.
        await this.#sem.add(() => {
          this.#renderedIds.clear();
          this.#firstId   = undefined;   // → #doRenderBatch loads from the newest end
          this.#newestId  = undefined;
          this.#fwdPruned = false;
          for (const el of Array.from(log.querySelectorAll("li.chat-message"))) el.remove();
          return this.#doRenderBatch(bs());
        });
        await this.scrollBottom();
      } catch { /* no-op */ }
    }

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

    #stampMessageOrder(el, index) {
      try {
        const n = Number(index);
        if (!Number.isFinite(n) || n < 0) return el;
        if (el?.dataset) el.dataset.order = String(n);
      } catch { /* no-op */ }
      return el;
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
