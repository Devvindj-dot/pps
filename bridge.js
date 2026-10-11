// bridge.js — ISOLATED world relay between content.js (MAIN world) and background.js
(function () {
  "use strict";

  if (window.__ppsBridgeRunning) return;
  window.__ppsBridgeRunning = true;

  let queue = [];
  let isWriting = false;

  function flushQueue() {
    if (isWriting || queue.length === 0) return;
    isWriting = true;

    try {
      chrome.storage.local.get("logs", function (data) {
        const logs = data.logs || [];
        const batch = queue.splice(0);
        logs.push(...batch);
        if (logs.length > 200) logs.splice(0, logs.length - 200);
        chrome.storage.local.set({ logs: logs }, function () {
          isWriting = false;
          if (queue.length > 0) flushQueue();
        });
      });
    } catch (e) {
      isWriting = false;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window || !event.data) return;

    // ─── Log forwarding ───────────────────────────────────────────────────────
    if (event.data.type === "__PPS_LOG__" && event.data.entry) {
      queue.push(event.data.entry);
      flushQueue();
    } else if (event.data.type === "__PPS_CLEAR_LOGS__") {
      queue = [];
      try {
        chrome.storage.local.set({ logs: [] });
      } catch (e) {}
    }

    // ─── Timeout lookup (lets the popup tune slow endpoints) ────────────────
    if (event.data.type === "__PPS_GET_TIMEOUT__") {
      chrome.storage.local.get(["aiTimeoutSec"], (s) => {
        window.postMessage(
          {
            type: "__PPS_TIMEOUT__",
            requestId: event.data.requestId,
            timeoutMs: Math.max(15, Number(s.aiTimeoutSec) || 120) * 1000,
          },
          "*"
        );
      });
      return;
    }

    // ─── AI Request forwarding (MAIN world → ISOLATED world → background.js) ─
    if (event.data.type === "__PPS_AI_REQUEST__" && event.data.requestId) {
      const { requestId, question } = event.data;

      chrome.storage.local.get(["apiKey", "baseUrl", "model"], (settings) => {
        const payload = {
          type: "__PPS_AI_REQUEST__",
          question,
          settings: {
            apiKey: settings.apiKey || "",
            baseUrl: settings.baseUrl || "https://api.openai.com/v1",
            model: settings.model || "gpt-4o-mini",
          },
        };

        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            window.postMessage(
              {
                type: "__PPS_AI_RESPONSE__",
                requestId,
                error: chrome.runtime.lastError.message,
              },
              "*"
            );
            return;
          }

          window.postMessage(
            {
              type: "__PPS_AI_RESPONSE__",
              requestId,
              answer: response?.answer || "",
              error: response?.error || null,
            },
            "*"
          );
        });
      });
    }
  });
})();