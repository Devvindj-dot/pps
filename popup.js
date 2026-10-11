// popup.js

const TARGET_HOST = "instatest.programmingpathshala.com";

const el = (id) => document.getElementById(id);
const setStatus = (id, msg, color = "#ffcc66") => {
  const e = el(id);
  e.textContent = msg;
  e.style.color = color;
};

el("verTag").textContent = "v" + chrome.runtime.getManifest().version;
el("saveBtn").addEventListener("click", saveSettings);
el("testBtn").addEventListener("click", testAI);
el("injectBtn").addEventListener("click", inject);
el("clearBtn").addEventListener("click", clearLogs);

(async function init() {
  loadSettings();
  showContext(await activeTab());
  loadLogs();
})();

function storageGet(keys) {
  return new Promise((r) => chrome.storage.local.get(keys, r));
}
function storageSet(obj) {
  return new Promise((r) => chrome.storage.local.set(obj, r));
}

// ─── Settings ──────────────────────────────────────────────────────────────
// Saving always asks for full host access, so any base URL works afterwards.
// We only prompt when the permission is not already granted, so repeated saves
// stay silent.
async function saveSettings() {
  const apiKey = el("apiKey").value.trim();
  const baseUrl = el("baseUrl").value.trim() || "https://api.openai.com/v1";
  const model = el("model").value.trim() || "gpt-4o-mini";
  const aiTimeoutSec = Math.max(15, parseInt(el("aiTimeoutSec").value, 10) || 120);

  await storageSet({ apiKey, baseUrl, model, aiTimeoutSec });

  let hadAll = false;
  try {
    hadAll = await chrome.permissions.contains({ origins: ["*://*/*"] });
  } catch (e) {
    /* stale manifest — fall through to the request below */
  }

  if (hadAll) {
    setStatus("settingsStatus", "Saved. Can reach any host.", "#3ddc84");
    return;
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ["*://*/*"] });
  } catch (e) {
    // Stale manifest → optional_host_permissions is not loaded yet.
    setStatus(
      "settingsStatus",
      "Saved. Reload the extension at chrome://extensions to enable any-host access.",
      "#ffcc66"
    );
    return;
  }

  setStatus(
    "settingsStatus",
    granted ? "Saved. Any-host access granted." : "Saved, but any-host access was declined.",
    granted ? "#3ddc84" : "#ff6b6b"
  );
}

function loadSettings() {
  chrome.storage.local.get(["apiKey", "baseUrl", "model", "aiTimeoutSec"], (data) => {
    if (data.apiKey) el("apiKey").value = data.apiKey;
    if (data.baseUrl) el("baseUrl").value = data.baseUrl;
    if (data.model) el("model").value = data.model;
    if (data.aiTimeoutSec) el("aiTimeoutSec").value = data.aiTimeoutSec;
  });
}

// ─── Logs ──────────────────────────────────────────────────────────────────

function loadLogs() {
  chrome.storage.local.get("logs", (d) => {
    const e = el("logs");
    const logs = d.logs || [];
    e.textContent = logs.join("\n") || "No logs yet.";
    e.scrollTop = e.scrollHeight;
  });
}

function clearLogs() {
  chrome.storage.local.set({ logs: [] });
  el("logs").textContent = "Cleared.";
}

// ─── Page context ──────────────────────────────────────────────────────────

async function showContext(tab) {
  const c = el("ctx");
  if (!tab?.url) {
    c.textContent = "No active tab.";
    return { ok: false };
  }
  let assessmentId = null;
  let questionId = null;
  try {
    const u = new URL(tab.url);
    const m = u.pathname.match(/\/assessment\/([^/]+)\/(?:problem|problems)(?:\/([^/?#]+))?/i);
    if (m) {
      assessmentId = m[1];
      questionId = m[2] ? decodeURIComponent(m[2]) : null;
    }
  } catch (e) {}

  const onTarget = tab.url.includes(TARGET_HOST);
  c.innerHTML =
    `<div><span class="lbl">site </span><span class="val">${escapeHtml(new URL(tab.url).host)}</span>` +
    `${onTarget ? "" : " <span class=\"lbl\">(dev)</span>"}</div>` +
    (assessmentId
      ? `<div><span class="lbl">assessment </span><span class="val">${escapeHtml(assessmentId)}</span></div>` +
        `<div><span class="lbl">question </span><span class="val">${escapeHtml(questionId || "problem list")}</span></div>`
      : `<div><span class="lbl">open an assessment question page to use the solver</span></div>`);

  return { ok: true, onTarget, assessmentId, questionId, url: tab.url };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function activeTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
  });
}

// ─── Injection (allowed on any site) ───────────────────────────────────────

async function inject() {
  const e = el("logs");
  const tab = await activeTab();
  if (!tab?.id) {
    e.textContent = "No active tab.";
    return;
  }
  await showContext(tab);

  chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] }, () => {
    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, world: "MAIN", files: ["content.js"] },
      () => {
        if (chrome.runtime.lastError) {
          e.textContent = "Inject error: " + chrome.runtime.lastError.message;
        } else {
          e.textContent = "Injected — Alt+Z to solve, Alt+X for the answer panel.";
          setTimeout(loadLogs, 1500);
        }
      }
    );
  });
}


// ─── Test AI ───────────────────────────────────────────────────────────────
// Isolates the AI layer: sends two known questions through the exact same
// background → offscreen → endpoint path the solver uses, and checks the shape
// of what comes back. Distinguishes an endpoint problem from a page problem.

const DEMO_MCQ = {
  type: "MCQ",
  name: "What is the capital of France?",
  description: "<p>Choose the correct answer.</p>",
  isMultiCorrect: false,
  options: [
    { id: "o1", value: "Berlin" },
    { id: "o2", value: "Madrid" },
    { id: "o3", value: "Paris" },
    { id: "o4", value: "Rome" },
  ],
};

const DEMO_CODE = {
  type: "CODING",
  name: "Add Two Numbers",
  description: "<p>Return a + b.</p>",
  coding_mode: "FUNCTION_SIGNATURE",
  language: "cpp",
  boilerplate_languages: {
    cpp: {
      prefix: "#include <bits/stdc++.h>\nusing namespace std;",
      placeholder: "\nint add(int a, int b) {\n    // Write your solution here\n    return 0;\n}\n",
      suffix: "int main() { int a, b; cin >> a >> b; cout << add(a, b); }",
    },
  },
};

function sendAI(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function testAI() {
  const out = el("logs");
  const s = await storageGet(["apiKey", "baseUrl", "model"]);
  const baseUrl = s.baseUrl || "https://api.openai.com/v1";
  const model = s.model || "gpt-4o-mini";
  const keyless = /opencode\.ai|127\.0\.0\.1|localhost|\.local/i.test(baseUrl);

  if (!s.apiKey && !keyless) {
    out.textContent =
      `No API key set for this endpoint.\n\nBase URL: ${baseUrl}\n\n` +
      "Add a key, or point Base URL at a local / keyless endpoint.";
    return;
  }

  out.textContent = `Testing… ${model} @ ${baseUrl}`;

  const lines = [];

  // 1) MCQ — expect a single letter
  try {
    const res = await sendAI({
      type: "__PPS_AI_REQUEST__",
      question: DEMO_MCQ,
      settings: { apiKey: s.apiKey || "", baseUrl, model },
    });
    if (res && res.error) {
      lines.push(`MCQ    : ERROR — ${res.error}`);
    } else {
      const answer = ((res && res.answer) || "").trim();
      const letter = (answer[0] || "?").toUpperCase();
      const idx = letter.charCodeAt(0) - 65;
      const matched = idx >= 0 && idx < DEMO_MCQ.options.length ? DEMO_MCQ.options[idx].value : null;
      lines.push(
        `MCQ    : ${matched === "Paris" ? "OK" : "CHECK"} — ${JSON.stringify(answer.slice(0, 30))}` +
          (matched ? ` -> ${letter}) ${matched}` : "")
      );
    }
  } catch (e) {
    lines.push(`MCQ    : FAILED — ${e.message}`);
  }

  // 2) CODING — expect the editable region only
  try {
    const res = await sendAI({
      type: "__PPS_AI_REQUEST__",
      question: DEMO_CODE,
      settings: { apiKey: s.apiKey || "", baseUrl, model },
    });
    if (res && res.error) {
      lines.push(`CODING : ERROR — ${res.error}`);
    } else {
      const a = ((res && res.answer) || "").trim();
      const hasMain = /int\s+main\s*\(|def\s+main\s*\(/.test(a);
      const hasFence = /^```/.test(a);
      lines.push(
        `CODING : ${hasMain || hasFence ? "CHECK" : "OK"} — ${a.length} chars` +
          (hasMain ? " [includes main()]" : "") +
          (hasFence ? " [markdown fence]" : "")
      );
      lines.push("");
      lines.push(a.slice(0, 500) || "(empty)");
    }
  } catch (e) {
    lines.push(`CODING : FAILED — ${e.message}`);
  }

  out.textContent = lines.join("\n");
}