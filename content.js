// content.js — MAIN world
// Intercepts the assessment question payload, asks the AI for an answer and
// injects it into the page (MCQ option, Monaco editor, or descriptive textarea).
(function () {
  "use strict";

  if (window.__ppsPocRunning) return;
  window.__ppsPocRunning = true;

  const DELAY_MIN = 250;
  const DELAY_MAX = 450;
  const MANUAL_FETCH_DELAY = 700;
  const AI_TIMEOUT_MS = 120000;

  // Bump this whenever the code changes. The first log line on every page load
  // prints it, so you can confirm Chrome is actually running the current build.
  const BUILD = "2026-10-09-overlay-hotkeys-v3";

  const API =
    (typeof window !== "undefined" && window.__PPS_API_BASE) ||
    "https://backend.programmingpathshala.com/rest/assessments/v1/assessment";

  let currentAssessmentId = null;
  let questions = [];
  let questionsById = {};
  let busy = false;

  let logBuffer = [];
  let logTimer = null;

  // ─── Logging ──────────────────────────────────────────────────────────────
  function log(msg) {
    try {
      const entry = new Date().toLocaleTimeString() + " | " + msg;
      logBuffer.push(entry);
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        if (!logTimer) logTimer = setTimeout(flushLogs, 200);
      } else {
        window.postMessage({ type: "__PPS_LOG__", entry }, "*");
      }
    } catch (e) {}
  }

  function flushLogs() {
    logTimer = null;
    if (logBuffer.length === 0) return;
    const batch = logBuffer.splice(0);
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        chrome.storage.local.get("logs", (data) => {
          const logs = data.logs || [];
          logs.push(...batch);
          if (logs.length > 200) logs.splice(0, logs.length - 200);
          chrome.storage.local.set({ logs });
        });
      }
    } catch (e) {}
  }

  // ─── Text helpers ─────────────────────────────────────────────────────────
  function stripHtml(input) {
    if (!input) return "";
    if (typeof input !== "string") return String(input);
    const trimmed = input.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && Array.isArray(parsed.ops)) {
          return parsed.ops
            .map((op) => (typeof op.insert === "string" ? op.insert : ""))
            .join("")
            .replace(/\n+/g, " ")
            .trim();
        }
      } catch (e) {
        /* fall through */
      }
    }
    return input
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalize(text) {
    return stripHtml(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanCode(code) {
    return (code || "")
      .replace(/^```[\w]*\n?/gm, "")
      .replace(/```$/gm, "")
      .trim();
  }

  function detectLanguage(code) {
    if (!code) return null;
    if (/^\s*#include/m.test(code) || /using namespace/.test(code) || /std::/.test(code)) {
      return "cpp";
    }
    if (/public class Main/.test(code) || /System\.out/.test(code) || /public static void main/.test(code)) {
      return "java";
    }
    if (/^\s*import sys/m.test(code) || /^\s*def \w+\(/m.test(code)) return "python";
    return null;
  }

  function lastUsedLanguage() {
    try {
      const v = localStorage.getItem("lastUsedLanguage");
      return v || null;
    } catch (e) {
      return null;
    }
  }

  // ─── Question data ────────────────────────────────────────────────────────
  function processQuestions(list, assessmentId, source) {
    if (assessmentId && currentAssessmentId === assessmentId && questions.length > 0) return;

    questions = Array.isArray(list) ? list : [];
    questionsById = {};
    for (const q of questions) {
      if (q && q.questionId) questionsById[q.questionId] = q;
      else if (q && q.id) questionsById[q.id] = q;
    }
    if (assessmentId) currentAssessmentId = assessmentId;

    log(`[PoC] Processed [${source}] ${questions.length} questions`);
  }

  function fetchQuestionsNow(assessmentId, attemptId) {
    return fetch(`${API}/questions/${assessmentId}/${attemptId}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data?.data) {
          processQuestions(data.data, assessmentId, "on-demand");
          return true;
        }
        log("[PoC] On-demand questions returned: " + JSON.stringify(data).slice(0, 160));
        return false;
      })
      .catch((e) => {
        log("[PoC] On-demand fetch error: " + e.message);
        return false;
      });
  }

  function fetchQuestions(assessmentId, attemptId) {
    setTimeout(() => {
      if (questions.length > 0) return;
      log(`[PoC] Fetching questions fallback: ${assessmentId}/${attemptId}`);
      fetchQuestionsNow(assessmentId, attemptId);
    }, MANUAL_FETCH_DELAY);
  }

  // ─── Network interception ─────────────────────────────────────────────────
  function matchesQuestionsApi(url) {
    return (
      url.includes("backend.programmingpathshala.com/rest/assessments/v1/assessment/questions/")
    );
  }

  function interceptXHR() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ppsUrl = url;
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          const url = this.__ppsUrl || "";
          if (!matchesQuestionsApi(url)) return;
          const data = JSON.parse(this.responseText);
          if (data?.data) {
            const m = url.match(/\/questions\/([^/?]+)/);
            processQuestions(data.data, m ? m[1] : null, "xhr");
          }
        } catch (e) {}
      });
      return origSend.apply(this, args);
    };
  }

  function interceptFetch() {
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      return origFetch.apply(this, args).then((response) => {
        try {
          if (matchesQuestionsApi(url)) {
            response
              .clone()
              .json()
              .then((data) => {
                if (data?.data) {
                  const m = url.match(/\/questions\/([^/?]+)/);
                  processQuestions(data.data, m ? m[1] : null, "fetch");
                }
              })
              .catch(() => {});
          }
        } catch (e) {}
        return response;
      });
    };
  }

  // ─── SPA navigation tracking ──────────────────────────────────────────────
  function getContext() {
    const m = window.location.pathname.match(
      /\/assessment\/([^/]+)\/(?:problem|problems)(?:\/([^/?#]+))?/i
    );
    if (!m) return null;
    let attemptId = null;
    try {
      attemptId = sessionStorage.getItem("attempt_id");
    } catch (e) {}
    return { assessmentId: m[1], questionId: m[2] ? decodeURIComponent(m[2]) : null, attemptId };
  }

  function watchForUrlChange() {
    let lastUrl = "";

    const checkUrl = () => {
      const cur = window.location.href;
      if (cur === lastUrl) return;
      lastUrl = cur;

      const ctx = getContext();
      if (!ctx) return;

      if (ctx.assessmentId !== currentAssessmentId) {
        log(`[PoC] Assessment detected: ${ctx.assessmentId}`);
      }
      if (ctx.attemptId && questions.length === 0) {
        fetchQuestions(ctx.assessmentId, ctx.attemptId);
      }
    };

    const origPush = history.pushState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(checkUrl, 50);
    };
    const origReplace = history.replaceState;
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(checkUrl, 50);
    };

    window.addEventListener("popstate", () => setTimeout(checkUrl, 50));
    window.addEventListener("hashchange", () => setTimeout(checkUrl, 50));
    setInterval(checkUrl, 400);
    checkUrl();
  }

  // ─── Current question lookup ──────────────────────────────────────────────
  async function findCurrentQuestion() {
    const ctx = getContext();

    // If nothing was captured yet (direct page load, cached React Query, ...),
    // pull the payload on demand rather than giving up.
    if (questions.length === 0 && ctx?.assessmentId && ctx?.attemptId) {
      log("[PoC] No questions captured yet — fetching on demand");
      await fetchQuestionsNow(ctx.assessmentId, ctx.attemptId);
    }

    if (ctx?.questionId && questionsById[ctx.questionId]) {
      return questionsById[ctx.questionId];
    }

    if (ctx?.questionId) {
      log(`[PoC] Question ${ctx.questionId} not in payload (have ${questions.length})`);
    }

    if (questions.length === 0) return null;

    // Fallback: match rendered question text against known titles
    const bodyText = document.body ? document.body.innerText : "";
    const normBody = normalize(bodyText);
    for (const q of questions) {
      const name = normalize(q.name);
      if (name && normBody.includes(name)) return q;
    }

    return null;
  }

  function questionType(q) {
    const t = (q?.type || "").toUpperCase();
    if (t === "MCQ") return "MCQ";
    if (t === "DESCRIPTIVE") return "DESCRIPTIVE";
    return "CODING";
  }

  // Which question kind is actually rendered? Uses the platform's own section
  // class names, which are stable, instead of guessing from the payload.
  function detectRenderedType() {
    try {
      if (document.querySelector(".mcq-question-section")) return "MCQ";
      if (document.querySelector(".descriptive-question-section")) return "DESCRIPTIVE";
      if (
        document.querySelector(".monaco-editor") ||
        document.querySelector("textarea.inputarea") ||
        document.querySelector(".monaco-scrollable-element")
      ) {
        return "CODING";
      }
    } catch (e) {}
    return null;
  }

  // ─── Boilerplate buffer assembly ──────────────────────────────────────────
  // Mirrors the platform's own W(): the submitted source_code is the editor
  // buffer minus the first `prefixLines` lines and the last `suffixLines` lines.
  // So for FUNCTION_SIGNATURE questions we must rebuild the buffer as
  // prefix + solution + suffix, otherwise the platform would strip the wrong
  // lines and submit broken code.
  const DISPLAY_TO_KEY = {
    c: "c",
    "c++": "cpp",
    "c#": "csharp",
    go: "go",
    java: "java",
    javascript: "javascript",
    python: "python",
    swift: "swift",
    scala: "scala",
  };

  function boilerplateFor(question, lang) {
    const boiler = question?.boilerplate_languages;
    if (!boiler || typeof boiler !== "object") return null;
    const entry = boiler[lang] || boiler[DISPLAY_TO_KEY[lang]] || null;
    return entry && typeof entry === "object" ? entry : null;
  }

  function stripTrailingNewlines(s) {
    return (s == null ? "" : String(s)).replace(/\n+$/, "");
  }

  function stripLeadingNewlines(s) {
    return (s == null ? "" : String(s)).replace(/^\n+/, "");
  }

  function extractEditableRegion(fullCode, entry) {
    const prefix = stripTrailingNewlines(entry.prefix);
    const suffix = stripLeadingNewlines(entry.suffix);
    const prefixLines = prefix ? prefix.split("\n").length : 0;
    const suffixLines = suffix ? suffix.split("\n").length : 0;
    const lines = String(fullCode).split("\n");
    return lines
      .slice(prefixLines, suffixLines > 0 ? lines.length - suffixLines : undefined)
      .join("\n");
  }

  function assembleBuffer(question, lang, aiCode) {
    const entry = boilerplateFor(question, lang);
    const isSignatureMode = question?.coding_mode === "FUNCTION_SIGNATURE";

    if (!entry || !isSignatureMode) {
      // No fixed prefix/suffix: the AI's answer is the whole program.
      return aiCode;
    }

    // The AI may ignore the instruction and return the entire program.
    // Detect that and re-extract just the editable region.
    let body = aiCode;
    const looksLikeFullProgram =
      /(^|\n)\s*(int\s+main|public\s+static\s+void\s+main|def\s+main|#include|import\s+sys)/.test(
        aiCode
      ) || /using\s+namespace\s+std/.test(aiCode);

    if (looksLikeFullProgram) {
      log("[PoC] AI returned a full program — extracting editable region");
      body = extractEditableRegion(aiCode, entry);
      body = body.replace(/^\s*|\s*$/g, "");
      return [stripTrailingNewlines(entry.prefix), body, stripLeadingNewlines(entry.suffix)]
        .filter((p) => p.length > 0)
        .join("\n");
    }

    return [stripTrailingNewlines(entry.prefix), body.trim(), stripLeadingNewlines(entry.suffix)]
      .filter((p) => p.length > 0)
      .join("\n");
  }

  // ─── Direct backend submission (bypasses the constrained editor) ─────────
  // The editor is locked to the function region by constrained-editor-plugin,
  // so instead of fighting it we talk to the same endpoint the page's own
  // "Submit" button uses:
  //   POST /assessment/submit-code/{assessmentId}/{attemptId}
  //   { email, language, question_id, source_code }
  // `source_code` must be the editable region ONLY (the platform supplies its
  // own main driver) — sending a whole program fails with
  // "error: redefinition of 'int main()'".

  // Display values the backend expects for `language`.
  const LANG_TO_API = {
    cpp: "c++",
    "c++": "c++",
    csharp: "c#",
    "c#": "c#",
    java: "java",
    javascript: "javascript",
    python: "python",
    go: "go",
    swift: "swift",
    scala: "scala",
    c: "c",
  };

  function apiLanguage(lang) {
    return LANG_TO_API[String(lang || "").toLowerCase()] || "c++";
  }

  // The email the page sends is read from the (non-HttpOnly) `user` JWT cookie.
  function getAuthEmail() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)user=([^;]+)/);
      if (!m) return null;
      const token = decodeURIComponent(m[1]);
      const part = token.split(".")[1];
      if (!part) return null;
      const padded = part.replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(padded));
      return json.email || null;
    } catch (e) {
      return null;
    }
  }

  function submitCodeDirectly(assessmentId, attemptId, questionId, sourceCode, lang) {
    const email = getAuthEmail();
    if (!email) {
      log("[PoC] Could not read email from the 'user' cookie");
      return Promise.resolve({ ok: false, error: "no email in user cookie" });
    }

    const url = `${API}/submit-code/${assessmentId}/${attemptId}`;
    const body = {
      email,
      language: apiLanguage(lang),
      question_id: questionId,
      source_code: sourceCode,
    };

    log(`[PoC] POST submit-code lang=${body.language} qid=${questionId} (${sourceCode.length} chars)`);

    return fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (r) => {
        const text = await r.text();
        if (!r.ok) {
          let msg = text.slice(0, 200);
          try {
            const j = JSON.parse(text);
            msg = j.message || (j.errors && j.errors.map((e) => e.msg).join("; ")) || msg;
          } catch (e) {}
          log(`[PoC] submit-code rejected (${r.status}): ${msg}`);
          return { ok: false, error: msg };
        }
        const data = JSON.parse(text);
        const tokens = (data.batchResponse || []).map((t) => t.token).filter(Boolean);
        const submissionId = data.submission_id || null;
        log(`[PoC] submit-code accepted (submission_id=${submissionId}, tokens=${tokens.length})`);
        return { ok: true, tokens, submissionId };
      })
      .catch((e) => {
        log("[PoC] submit-code network error: " + e.message);
        return { ok: false, error: e.message };
      });
  }

  // Poll the verdict endpoint the way the page does (exponential backoff).
  function pollVerdict(assessmentId, attemptId, questionId, tokens, submissionId) {
    if (!tokens || tokens.length === 0) return Promise.resolve(null);

    const csv = tokens.join(",");
    let attempt = 0;
    const delay = (n) => Math.min(1000 * Math.pow(3, n), 12000);

    const tick = () => {
      const params = new URLSearchParams({
        tokens_csv: csv,
        run_type: "SUBMIT",
        question_id: questionId,
        attempt_id: attemptId,
        submission_id: submissionId || "",
      });

      return fetch(`${API}/verdict/coding/${assessmentId}?${params.toString()}`, {
        credentials: "include",
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const resp = (data && data.verdictResponse) || {};
          const entries = Object.values(resp);
          const pending = entries.filter(
            (v) =>
              typeof v.verdict === "string" &&
              (v.verdict === "In Queue" || v.verdict === "Processing" || v.verdict === "Pending")
          );
          if (pending.length === 0 && entries.length > 0) return resp;
          if (attempt >= 6) return resp;
          attempt++;
          return new Promise((r) => setTimeout(r, delay(attempt))).then(tick);
        })
        .catch(() => null);
    };

    return tick();
  }

  // Keep the page's own autosave in sync so a reload shows the submitted code.
  // The page stores useLocalStorage("autosaves", {}) keyed by
  // "<attemptId>_<questionId>.<editorLanguage>" holding the editable region.
  function syncLocalAutosave(attemptId, questionId, lang, body) {
    try {
      const key = "autosaves";
      let store = {};
      const raw = localStorage.getItem(key);
      if (raw) {
        try {
          store = JSON.parse(raw);
        } catch (e) {
          store = {};
        }
      }
      store[`${attemptId}_${questionId}.${lang}`] = body;
      localStorage.setItem(key, JSON.stringify(store));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ─── AI request (via bridge.js → background.js) ───────────────────────────
  // Answers are cached per question so repeatedly opening the answer panel
  // never re-hits the AI endpoint. Re-asking can return a *different* answer,
  // which is both slow and confusing. Alt+Z deliberately forces a refresh.
  const answerCache = new Map(); // cacheKey -> { answer, at }
  const inflight = new Map(); // cacheKey -> Promise

  function cacheKey(question) {
    return `${question.questionId || "?"}|${question.type || ""}|${question.language || ""}`;
  }

  function requestAIAnswerOnce(question) {
    const key = cacheKey(question);
    if (inflight.has(key)) {
      log("[PoC] Joining the AI request already in flight");
      return inflight.get(key);
    }
    const p = requestAIAnswer(question).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function requestAIAnswerCached(question, force) {
    const key = cacheKey(question);
    if (!force) {
      const hit = answerCache.get(key);
      if (hit) {
        const age = Math.round((Date.now() - hit.at) / 1000);
        log(`[PoC] Reusing cached answer (asked ${age}s ago) — press Alt+Z to re-solve`);
        return Promise.resolve(hit.answer);
      }
    }
    return requestAIAnswerOnce(question).then((answer) => {
      answerCache.set(key, { answer, at: Date.now() });
      return answer;
    });
  }

  function clearAnswerCache() {
    const n = answerCache.size;
    answerCache.clear();
    log(`[PoC] Cleared ${n} cached answer(s)`);
  }

  // Ask the popup's setting (seconds) for how long to allow per AI request.
  function getAiTimeout() {
    return new Promise((resolve) => {
      const requestId = "__TO_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(AI_TIMEOUT_MS);
      }, 1500);

      function handler(event) {
        if (event.data?.type === "__PPS_TIMEOUT__" && event.data?.requestId === requestId) {
          clearTimeout(timer);
          window.removeEventListener("message", handler);
          resolve(event.data.timeoutMs);
        }
      }
      window.addEventListener("message", handler);
      window.postMessage({ type: "__PPS_GET_TIMEOUT__", requestId }, "*");
    });
  }

  function requestAIAnswer(question) {
    return new Promise((resolve, reject) => {
      const requestId = "__AI_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      let settled = false;

      const handler = (event) => {
        if (event.data?.type === "__PPS_AI_RESPONSE__" && event.data?.requestId === requestId) {
          settled = true;
          window.removeEventListener("message", handler);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.answer);
        }
      };
      window.addEventListener("message", handler);

      getAiTimeout().then((ms) => {
        if (settled) return;
        setTimeout(() => {
          if (settled) return;
          window.removeEventListener("message", handler);
          reject(new Error("AI request timed out (" + Math.round(ms / 1000) + "s)"));
        }, ms);
      });

      window.postMessage({ type: "__PPS_AI_REQUEST__", requestId, question }, "*");
    });
  }

  // ─── Monaco editor access ─────────────────────────────────────────────────
  function isMonacoEditor(obj) {
    return (
      obj &&
      typeof obj === "object" &&
      typeof obj.getModel === "function" &&
      typeof obj.executeEdits === "function"
    );
  }

  function reactFiberKey(el) {
    if (!el) return null;
    return (
      Object.keys(el).find(
        (k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")
      ) || null
    );
  }

  // Scan one React fiber chain (and its hook list) for a Monaco editor instance.
  function scanFiber(fiber, seen) {
    let depth = 0;
    let f = fiber;
    while (f && depth < 80) {
      let hook = f.memoizedState;
      let guard = 0;
      while (hook && guard < 120) {
        const val = hook.memoizedState;
        if (val && typeof val === "object" && !seen.has(val)) {
          seen.add(val);
          if (isMonacoEditor(val)) return val;
          if (val.current && typeof val.current === "object" && !seen.has(val.current)) {
            seen.add(val.current);
            if (isMonacoEditor(val.current)) return val.current;
          }
        }
        hook = hook.next;
        guard++;
      }
      // useState initialiser closures / memoised objects occasionally hold it
      const node = f.stateNode;
      if (node && typeof node === "object" && isMonacoEditor(node)) return node;
      f = f.return;
      depth++;
    }
    return null;
  }

  // The app runs `delete window.monaco`, but grab it if it ever survives.
  function editorFromGlobal() {
    try {
      const m = window.monaco;
      if (m && m.editor && typeof m.editor.getEditors === "function") {
        const list = m.editor.getEditors();
        if (list && list.length) return list[0];
      }
      if (m && m.editor && m.editor.getModels && m.editor.getModels().length) {
        // No editor list API: fall back to a model-driven pseudo-editor shim
        return null;
      }
    } catch (e) {}
    return null;
  }

  function findMonacoEditor() {
    const fromGlobal = editorFromGlobal();
    if (fromGlobal) {
      log("[PoC] Monaco editor found via window.monaco");
      return fromGlobal;
    }

    // Monaco 0.55 puts `.monaco-editor` on inner nodes (overflow widgets,
    // gutter, ...) rather than the React container, so collect several anchors
    // and walk each one UP to the nearest React host node.
    const anchors = new Set();
    for (const sel of [
      ".monaco-editor",
      ".monaco-scrollable-element",
      ".view-lines",
      ".monaco-diff-editor",
      ".overflow-guard",
      "textarea.inputarea",
      ".inputarea",
    ]) {
      try {
        document.querySelectorAll(sel).forEach((n) => anchors.add(n));
      } catch (e) {}
    }
    try {
      document
        .querySelectorAll("textarea")
        .forEach((n) => anchors.add(n));
    } catch (e) {}

    if (anchors.size === 0) {
      log("[PoC] No Monaco DOM anchors found (is this a coding question?)");
      return null;
    }

    const seen = new Set();
    for (const anchor of anchors) {
      let el = anchor;
      let hops = 0;
      while (el && hops < 40) {
        const key = reactFiberKey(el);
        if (key) {
          const found = scanFiber(el[key], seen);
          if (found) {
            log(`[PoC] Monaco editor found via React fiber (${hops} hops from .${anchor.className.split(" ")[0] || "node"})`);
            return found;
          }
        }
        el = el.parentElement;
        hops++;
      }
    }

    log(`[PoC] Monaco editor not reachable (checked ${anchors.size} DOM anchors)`);
    return null;
  }

  function getEditorCode() {
    const editor = findMonacoEditor();
    if (editor) {
      try {
        const model = editor.getModel();
        if (model) return model.getValue();
      } catch (e) {}
    }
    // Fallback: scrape the rendered lines (good enough to prompt the AI)
    try {
      const lines = document.querySelector(".view-lines");
      if (lines && lines.innerText) return lines.innerText.replace(/ /g, " ");
    } catch (e) {}
    return "";
  }

  // The platform installs a `constrained-editor` restriction on the Monaco model:
  //   range: [prefixLines + 1, 1, lineCount - suffixLines, getLineMaxColumn(lineCount - suffixLines)]
  // and decorates the prefix/suffix lines as `readonly-region`. Any edit that
  // touches those lines is reverted, which still fires the app's onChange (so the
  // "Saving…" indicator appears) but leaves the buffer unchanged.
  //
  // Therefore we must replace *exactly* that editable region and leave the
  // prefix/suffix lines byte-identical.
  function editableRange(model, entry) {
    const lineCount = model.getLineCount();
    if (!entry) {
      return { startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn: model.getLineMaxColumn(lineCount) };
    }

    const prefix = stripTrailingNewlines(entry.prefix);
    const suffix = stripLeadingNewlines(entry.suffix);
    const prefixLines = prefix ? prefix.split("\n").length : 0;
    const suffixLines = suffix ? suffix.split("\n").length : 0;

    const startLine = prefixLines + 1;
    const endLine = lineCount - suffixLines;

    if (!(startLine >= 1 && endLine >= startLine)) return null;

    return {
      startLineNumber: startLine,
      startColumn: 1,
      endLineNumber: endLine,
      endColumn: model.getLineMaxColumn(endLine),
    };
  }

  function fillCodeEditor(code, question, lang) {
    // Strategy 1: drive the editor instance directly (preferred)
    const editor = findMonacoEditor();
    if (editor) {
      try {
        const model = editor.getModel();
        const entry = boilerplateFor(question, lang);
        const range = editableRange(model, entry);

        if (!range) {
          log("[PoC] Could not compute editable region — falling back to whole buffer");
        } else {
          // Sanity: the model's prefix/suffix must already match the boilerplate,
          // otherwise our line math is wrong and we would clobber read-only text.
          const prefixLines = stripTrailingNewlines(entry?.prefix || "").split("\n").length;
          const actualPrefix = model.getValueInRange({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: Math.max(1, prefixLines),
            endColumn: model.getLineMaxColumn(Math.max(1, prefixLines)),
          });
          const expectedPrefix = stripTrailingNewlines(entry?.prefix || "");
          if (entry && actualPrefix.trim() !== expectedPrefix.trim()) {
            log("[PoC] Buffer prefix does not match boilerplate — using whole-buffer edit");
          } else {
            editor.executeEdits("pps-inject", [
              { range, text: code.replace(/\n+$/, ""), forceMoveMarkers: true },
            ]);
            editor.pushUndoStop();
            try {
              editor.focus();
            } catch (e) {}
            log(
              `[PoC] Injected ${code.length} chars into editable region ` +
                `(${range.startLineNumber}:1 → ${range.endLineNumber}:${range.endColumn})`
            );
            return true;
          }
        }

        // Fallback path: no boilerplate, or prefix mismatch → whole buffer.
        const fullRange = model.getFullModelRange();
        editor.executeEdits("pps-inject", [
          { range: fullRange, text: code, forceMoveMarkers: true },
        ]);
        editor.pushUndoStop();
        log(`[PoC] Code injected via executeEdits over full model (${code.length} chars)`);
        return true;
      } catch (e) {
        log("[PoC] executeEdits failed: " + e.message);
      }
    }

    // Strategy 2: type into Monaco's hidden textarea. Monaco owns the real
    // model, so an `insertText` editing command is applied to the document
    // and its onDidChangeModelContent listeners still fire.
    const textarea =
      document.querySelector(".monaco-editor textarea") ||
      document.querySelector("textarea.inputarea") ||
      document.querySelector(".view-lines")?.closest("div")?.querySelector("textarea");

    if (textarea) {
      try {
        textarea.focus();
        if (editor && typeof editor.getSelection === "function") {
          const sel = editor.getSelection();
          if (sel) editor.setSelection(sel);
        }
        // Select everything currently in the document
        document.execCommand("selectAll", false, null);
        const inserted = document.execCommand("insertText", false, code);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        log(
          `[PoC] Code injected via textarea execCommand (insertText=${inserted}, ${code.length} chars)`
        );
        return true;
      } catch (e) {
        log("[PoC] textarea injection failed: " + e.message);
      }
    }

    log("[PoC] Monaco editor not found — nothing injected");
    return false;
  }

  // ─── MCQ answer selection ─────────────────────────────────────────────────
  function parseSelectedIndexes(answerText, optionCount) {
    const letters = [];
    const matches = String(answerText).toUpperCase().match(/[A-Z]/g);
    if (matches) {
      for (const ch of matches) {
        const idx = ch.charCodeAt(0) - 65;
        if (idx >= 0 && idx < optionCount) letters.push(idx);
      }
    }
    if (letters.length > 0) return letters;

    const nums = String(answerText).match(/\d+/g);
    if (nums) {
      for (const n of nums) {
        const idx = parseInt(n, 10) - 1;
        if (idx >= 0 && idx < optionCount) letters.push(idx);
      }
    }
    return letters;
  }

  function clickOption(question, index) {
    const section = document.querySelector(".mcq-question-section");
    if (!section) {
      log("[PoC] MCQ section not found on screen");
      return false;
    }

    const inputs = section.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    if (inputs.length === 0) {
      log("[PoC] MCQ option inputs not found on screen");
      return false;
    }

    // Prefer matching by the platform's own option id
    const target = question?.options?.[index];
    let input = null;

    if (target?.id) {
      for (const el of inputs) {
        if (el.value === String(target.id)) {
          input = el;
          break;
        }
      }
    }
    if (!input) input = inputs[index];
    if (!input) return false;

    setTimeout(() => {
      try {
        input.click();
        log(`[PoC] MCQ selected option ${String.fromCharCode(65 + index)} (${input.value})`);
      } catch (e) {
        log("[PoC] Option click failed: " + e.message);
      }
    }, DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN));

    return true;
  }

  function selectMCQAnswer(question, answerText) {
    const options = question.options || [];
    const indexes = parseSelectedIndexes(answerText, options.length);

    if (indexes.length === 0) {
      log(`[PoC] Could not map AI answer to an option: "${String(answerText).slice(0, 60)}"`);
      return false;
    }

    const multi = !!(question.isMultiCorrect || question.isMultiSelect);
    const targets = multi ? indexes : [indexes[0]];

    log(
      `[PoC] MCQ targets: ${targets.map((i) => String.fromCharCode(65 + i)).join(",")} (multi=${multi})`
    );

    // The platform debounces its submit by 500ms and sends the accumulated
    // selection, so space clicks out beyond the debounce window. The final
    // click submits the complete set.
    targets.forEach((idx, i) => {
      setTimeout(() => clickOption(question, idx), i * 750);
    });

    return true;
  }

  // ─── Descriptive answer ───────────────────────────────────────────────────
  function fillDescriptiveAnswer(question, answerText) {
    const section = document.querySelector(".descriptive-question-section");
    const textarea = section
      ? section.querySelector("textarea")
      : document.querySelector('textarea[placeholder*="Type your answer"]');

    if (!textarea) {
      log("[PoC] Descriptive textarea not found");
      return false;
    }

    let text = String(answerText).replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();

    const limit = question?.characterLimit;
    if (limit && text.length > limit) {
      text = text.slice(0, limit);
      log(`[PoC] Descriptive answer truncated to ${limit} chars`);
    }

    try {
      // React-controlled textarea: use the native value setter so React sees it
      const proto =
        window.HTMLTextAreaElement.prototype || window.HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(textarea, text);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      log(`[PoC] Descriptive answer filled (${text.length} chars)`);
    } catch (e) {
      textarea.value = text;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      log(`[PoC] Descriptive answer filled via fallback (${text.length} chars)`);
    }

    // Click the platform's Save button so the answer is persisted server-side
    setTimeout(() => {
      try {
        const saveBtn = Array.from(document.querySelectorAll("button")).find(
          (b) => (b.textContent || "").trim().toLowerCase() === "save"
        );
        if (saveBtn) {
          saveBtn.click();
          log("[PoC] Clicked Save for descriptive answer");
        } else {
          log("[PoC] Save button not found — answer left unsaved");
        }
      } catch (e) {}
    }, 600);

    return true;
  }

  // ─── Solve orchestration ──────────────────────────────────────────────────
  async function solveWithAI() {
    if (busy) {
      log("[PoC] Already solving — ignoring duplicate trigger");
      return false;
    }
    busy = true;

    try {
      const question = await findCurrentQuestion();
      if (!question) {
        log("[PoC] No question detected on screen");
        return false;
      }

      let type = questionType(question);

      // Trust what is rendered on the page over a fuzzy title match: the
      // question sections carry stable class names, so use them to catch a
      // payload/screen mismatch instead of injecting into the wrong widget.
      const onScreen = detectRenderedType();
      if (onScreen && onScreen !== type) {
        log(`[PoC] Payload type ${type} != rendered type ${onScreen}; trusting the page`);
        type = onScreen;
      }

      log(`[PoC] Solving question ${question.questionId} "${question.name}" (type: ${type})`);

      // Give the AI the live editor buffer as the starter code for coding questions
      let payload = question;
      let codingLang = null;
      if (type === "CODING") {
        const live = getEditorCode();
        codingLang = detectLanguage(live) || lastUsedLanguage() || "cpp";
        if (live) {
          payload = {
            ...question,
            starterCode: live,
            currentCode: live,
            language: codingLang,
          };
        } else {
          payload = { ...question, language: codingLang };
        }
        log(`[PoC] Editor language: ${codingLang}`);
      }

      // Alt+Z always re-asks, so a wrong answer can be corrected on demand.
      const answer = await requestAIAnswerCached(payload, true);
      log(`[PoC] AI answer: ${String(answer).slice(0, 120).replace(/\n/g, " ")}`);

      if (!answer) {
        log("[PoC] Empty AI answer");
        return false;
      }

      if (type === "CODING") {
        const entry = boilerplateFor(question, codingLang);
        const signatureMode = entry && question.coding_mode === "FUNCTION_SIGNATURE";
        // The backend compiles only the editable region, so send the function.
        const sourceCode = signatureMode
          ? cleanCode(answer)
          : assembleBuffer(question, codingLang, cleanCode(answer));

        const ctx = getContext();

        // Primary path: submit straight to the backend. This sidesteps the
        // constrained editor entirely, so the read-only prefix/suffix and the
        // undo-on-out-of-range behaviour never come into play.
        if (ctx && ctx.assessmentId && ctx.attemptId) {
          const res = await submitCodeDirectly(
            ctx.assessmentId,
            ctx.attemptId,
            question.questionId,
            sourceCode,
            codingLang
          );

          if (res.ok) {
            syncLocalAutosave(ctx.attemptId, question.questionId, codingLang, sourceCode);
            log("[PoC] Local autosave synced (reload to see it in the editor)");

            if (res.tokens.length > 0) {
              log("[PoC] Waiting for verdict...");
              const verdict = await pollVerdict(
                ctx.assessmentId,
                ctx.attemptId,
                question.questionId,
                res.tokens,
                res.submissionId
              );
              if (verdict) {
                const summary = Object.values(verdict)
                  .map((v) => v.verdict)
                  .filter(Boolean);
                log(`[PoC] Verdict: ${summary.join(", ") || "(empty)"}`);
              }
            }
            return true;
          }

          log("[PoC] Direct submit failed — falling back to editor injection");
        }

        // Fallback: write into the Monaco editable region.
        log(`[PoC] Injecting ${sourceCode.length} chars (mode: ${question.coding_mode || "FULL_CODE"})`);
        return fillCodeEditor(sourceCode, question, codingLang);
      } else if (type === "DESCRIPTIVE") {
        return fillDescriptiveAnswer(question, answer);
      } else {
        return selectMCQAnswer(question, answer);
      }
    } catch (err) {
      log("[PoC] AI error: " + err.message);
      return false;
    } finally {
      busy = false;
    }
  }

  function solveCurrentPoC() {
    return solveWithAI();
  }

// ─── On-screen answer overlay (fallback) ─────────────────────────────────
  // A manual fallback that needs no backend round-trip: render the AI answer in
  // a panel so it can be read off-screen and typed by hand. It writes nothing
  // to the clipboard, never dispatches copy/paste, and therefore never trips
  // the page's preventCopy / preventUserSelection handlers.
  //
  // Long lines are PAGINATED, never truncated: each logical line is split into
  // as many segments as the panel width requires, and continuations are
  // prefixed with "↳" and labelled "part n/m" so it is obvious you are still on
  // the same logical line.
  const overlay = {
    root: null,
    body: null,
    meta: null,
    badge: null,
    lines: [],
    segments: [],
    index: 0, // index into `segments`
    visible: false,
    busy: false,
  };

  const OVERLAY_ID = "__pps_answer_overlay";

  function overlayStyle() {
    return `
      position: fixed; z-index: 2147483647;
      right: 12px; bottom: 12px;
      width: auto; max-width: min(620px, 52vw);
      display: flex; align-items: stretch;
      background: rgba(8,10,13,.95);
      color: #c9f7d2;
      border: 1px solid #1f6f3f; border-radius: 6px;
      box-shadow: 0 6px 24px rgba(0,0,0,.55);
      font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      text-align: left; letter-spacing: normal;
      white-space: nowrap;
      overflow: hidden; box-sizing: border-box;
    `;
  }

  function ensureOverlay() {
    if (overlay.root && overlay.root.isConnected) return overlay.root;

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.setAttribute("style", overlayStyle());

    const badge = document.createElement("span");
    badge.setAttribute(
      "style",
      "display:flex;align-items:center;padding:0 8px;border-right:1px solid #1f6f3f;" +
        "color:#7ee2a0;font-size:10px;white-space:nowrap;flex:0 0 auto;"
    );
    badge.textContent = "PPS";

    // Hard clip inside the panel: even if the width maths is ever off by a
    // character, text can never paint outside the box.
    const body = document.createElement("code");
    body.setAttribute(
      "style",
      "display:block;padding:4px 10px;color:#dcffe6;white-space:pre;" +
        "overflow:hidden;flex:0 1 auto;min-width:0;" +
        "user-select:text;-webkit-user-select:text;"
    );

    // Fixed-width counter column: it can never grow and steal room from the answer.
    const meta = document.createElement("span");
    meta.setAttribute(
      "style",
      "display:flex;align-items:center;justify-content:flex-end;padding:0 8px;" +
        "border-left:1px solid #1f6f3f;color:#5f8f72;font-size:10px;" +
        "white-space:nowrap;flex:0 0 auto;min-width:74px;"
    );

    root.appendChild(badge);
    root.appendChild(body);
    root.appendChild(meta);

    (document.body || document.documentElement).appendChild(root);

    overlay.root = root;
    overlay.body = body;
    overlay.meta = meta;
    overlay.badge = badge;
    return root;
  }

  // Pixels available to the answer text.
  // Deterministically computed from the *measured* widths of the badge and the
  // counter column, minus the panel's own budget. Flexbox is not trusted here:
  // it will happily squeeze the answer to nothing to honour its content size.
  function measureCharCapacity() {
    ensureOverlay();
    const code = overlay.body;
    if (!code) return { per: 60, charWidth: 7, avail: 480 };

    const savedWidth = code.style.width;
    const savedFlex = code.style.flex;
    const savedText = code.textContent;

    code.style.width = "";
    code.style.flex = "";

    // 1) intrinsic glyph width, from the unconstrained overflow width.
    const PROBE = 200;
    code.textContent = "M".repeat(PROBE);
    const intrinsic = code.scrollWidth;
    code.textContent = savedText;

    let charWidth = intrinsic > PROBE ? intrinsic / PROBE : 0;
    if (!(charWidth > 1)) charWidth = 7.2;

    // 2) exact room for the text, from the real sibling widths.
    const panelMax = Math.min(620, Math.round(window.innerWidth * 0.52));
    let badgeW = 36;
    let metaW = 74;
    try {
      if (overlay.badge) badgeW = overlay.badge.offsetWidth || badgeW;
      if (overlay.meta) metaW = overlay.meta.offsetWidth || metaW;
    } catch (e) {}

    const avail = Math.max(80, panelMax - badgeW - metaW - 2);

    code.style.width = avail + "px";
    code.style.flex = "0 0 auto";
    if (!savedWidth) code.style.width = avail + "px";
    if (savedFlex) code.style.flex = savedFlex;

    // 2 columns reserved for the "↳ " continuation marker.
    const per = Math.floor(avail / charWidth) - 2;
    return { per: Math.max(16, per), charWidth, avail };
  }

  // Tabs render far wider than one monospace cell and would break the fit.
  // They are whitespace, so widening them for display loses nothing.
  function expandTabs(s) {
    return s.replace(/\t/g, "  ");
  }

  // Split a logical line into display segments WITHOUT cutting words in half.
  // Breaks prefer the last whitespace in the window; a single token longer than
  // the window is the only case that has to hard-split, and only whitespace is
  // ever discarded — no non-whitespace character can be lost.
  function segmentLine(text, per) {
    const n = text.length;
    if (n <= per) return [text];

    const parts = [];
    let i = 0;

    while (i < n) {
      if (n - i <= per) {
        parts.push(text.slice(i));
        break;
      }

      const window = text.slice(i, i + per);

      // Last whitespace strictly inside the window (never at index 0, which
      // would produce an empty segment).
      let cut = -1;
      for (let j = window.length - 1; j > 0; j--) {
        if (/\s/.test(window[j])) {
          cut = j;
          break;
        }
      }

      if (cut > 0) {
        parts.push(window.slice(0, cut));
        i += cut;
        while (i < n && /\s/.test(text[i])) i++; // consume the break whitespace
      } else {
        parts.push(window);
        i += per;
      }
    }

    return parts.length > 0 ? parts : [text];
  }

  // Flatten the logical lines into display segments, never losing a character.
  function buildSegments(lines) {
    const { per, charWidth, avail } = measureCharCapacity();
    let width = per;

    // Hard guarantee: shrink until the widest possible segment (including the
    // "↳ " marker) genuinely fits the measured width. Bounded so it can never
    // loop forever on a pathological layout.
    const fits = (p) => (p + 2) * charWidth <= avail + 1;
    for (let i = 0; i < 24 && width > 12 && !fits(width); i--) width--;

    const segs = [];
    lines.forEach((line, li) => {
      const text = expandTabs(line == null ? "" : String(line));
      const pieces = segmentLine(text, width);
      pieces.forEach((p, pi) => {
        segs.push({ li, part: pi + 1, parts: pieces.length, text: p });
      });
    });

    return segs;
  }

  function renderOverlay() {
    if (!overlay.root) return;

    const total = overlay.segments.length;
    if (total === 0) {
      overlay.body.textContent = "(no answer)";
      overlay.meta.textContent = "0/0";
      return;
    }

    const seg = overlay.segments[Math.min(overlay.index, total - 1)];
    const isSplit = seg.parts > 1;
    const isContinuation = isSplit && seg.part > 1;

    // Only *continuations* get the ↳ marker. Part 1 of a split line must not
    // be marked, otherwise it reads as a continuation of something above it.
    overlay.body.textContent = isContinuation ? "↳ " + seg.text : seg.text || "·";

    overlay.meta.textContent = counterText(seg, overlay.index, total);
  }

  // Compact counter so it never steals width from the answer.
  function counterText(seg, index, total) {
    const pos = `${index + 1}/${total}`;
    return seg && seg.parts > 1 ? `${pos} L${seg.li + 1}·${seg.part}/${seg.parts}` : pos;
  }

  function showOverlay(text, label) {
    ensureOverlay();
    overlay.lines = String(text || "").replace(/\r/g, "").split("\n");
    if (overlay.lines.length === 0) overlay.lines = ["(empty answer)"];

    // Put a worst-case counter in place FIRST so flexbox has settled before we
    // measure how much room the answer text actually gets.
    if (overlay.meta) overlay.meta.textContent = "999/999 L999·9/9";

    overlay.segments = buildSegments(overlay.lines);
    overlay.index = 0;
    overlay.visible = true;
    renderOverlay();

    const wrapped = overlay.segments.length - overlay.lines.length;
    log(
      `[PoC] Answer panel shown (${overlay.lines.length} lines` +
        (wrapped > 0 ? `, ${overlay.segments.length} segments` : "") +
        `)${label ? " — " + label : ""}`
    );
  }

  function hideOverlay() {
    if (overlay.root) overlay.root.remove();
    overlay.root = null;
    overlay.visible = false;
    overlay.lines = [];
    overlay.segments = [];
    overlay.index = 0;
    log("[PoC] Answer panel hidden");
  }

  function overlayStep(delta) {
    if (!overlay.visible) return; // deliberate no-op: stepping is high frequency
    const max = Math.max(0, overlay.segments.length - 1);
    overlay.index = Math.min(max, Math.max(0, overlay.index + delta));
    renderOverlay();
  }

  // Re-page when the window resizes so nothing is ever clipped.
  let overlayResizeTimer = null;
  window.addEventListener("resize", () => {
    if (!overlay.visible || overlay.lines.length === 0) return;
    clearTimeout(overlayResizeTimer);
    overlayResizeTimer = setTimeout(() => {
      const logicalLine = overlay.segments[overlay.index]?.li ?? 0;
      const partIndex = (overlay.segments[overlay.index]?.part ?? 1) - 1;
      overlay.segments = buildSegments(overlay.lines);
      let idx = 0;
      for (let i = 0; i < overlay.segments.length; i++) {
        const s = overlay.segments[i];
        if (s.li === logicalLine && s.part - 1 === partIndex) {
          idx = i;
          break;
        }
        if (s.li > logicalLine) break;
      }
      overlay.index = idx;
      renderOverlay();
    }, 150);
  });

  // Ask the AI and only render — never writes to the page or the server.
  async function overlayCurrentPoC() {
    if (overlay.busy) {
      log("[PoC] Panel already fetching — ignoring");
      return false;
    }
    overlay.busy = true;
    try {
      const question = await findCurrentQuestion();
      if (!question) {
        log("[PoC] Overlay: no question detected");
        return false;
      }

      let type = questionType(question);
      const onScreen = detectRenderedType();
      if (onScreen && onScreen !== type) type = onScreen;

      let payload = question;
      let codingLang = null;
      if (type === "CODING") {
        const live = getEditorCode();
        codingLang = detectLanguage(live) || lastUsedLanguage() || "cpp";
        payload = live
          ? { ...question, starterCode: live, currentCode: live, language: codingLang }
          : { ...question, language: codingLang };
      }
      const cachedAnswer = answerCache.get(cacheKey(payload));

      log(
        `[PoC] Overlay: ${cachedAnswer ? "showing cached answer" : "asking AI"} for ${type} question…`
      );
      const answer = await requestAIAnswerCached(payload, false);
      if (!answer) {
        log("[PoC] Overlay: empty AI answer");
        return false;
      }

      let text = cleanCode(answer);
      if (type === "MCQ") {
        const options = question.options || [];
        const idx = parseSelectedIndexes(answer, options.length)[0];
        const picked = idx != null ? options[idx] : null;
        text =
          `${answer.trim()} — ${picked ? stripHtml(picked.value ?? "") : "(no match)"}\n` +
          (options.length
            ? options.map((o, i) => `${String.fromCharCode(65 + i)}) ${stripHtml(o.value ?? "")}`).join("\n")
            : "");
      } else if (type === "CODING") {
        const entry = boilerplateFor(question, codingLang);
        if (!entry || question.coding_mode !== "FUNCTION_SIGNATURE") {
          text = assembleBuffer(question, codingLang, text);
        }
      } else if (question.characterLimit) {
        text = text.slice(0, question.characterLimit);
      }

      showOverlay(text, `${type} · ${question.name || question.questionId}`);
      return true;
    } catch (err) {
      log("[PoC] Overlay error: " + err.message);
      return false;
    } finally {
      overlay.busy = false;
    }
  }
  // ─── Hotkey (capture phase, to run before page handlers) ──────────────────
  // Alt+Z      → solve the question (primary: AI answer is submitted, always
//               re-asks the AI so a wrong answer can be corrected)
  // Alt+X      → toggle the on-screen answer panel (backup / manual entry).
  //               Reuses the cached answer; only asks once per question.
  // Alt+Down   → panel: next line/part   Alt+Up → previous line/part
  // Alt+C      → clear cached answers
  function setupHotkey() {
    if (window.__ppsKeyHandler) {
      window.removeEventListener("keydown", window.__ppsKeyHandler, true);
    }

    window.__ppsKeyHandler = function (e) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;

      const k = (e.key || "").toUpperCase();
      const code = e.code || "";

      if (k === "ARROWDOWN" || code === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        overlayStep(1);
        return;
      }

      if (k === "ARROWUP" || code === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        overlayStep(-1);
        return;
      }

      if (k === "C" || code === "KeyC") {
        e.preventDefault();
        e.stopPropagation();
        clearAnswerCache();
        return;
      }

      if (k === "Z" || code === "KeyZ") {
        e.preventDefault();
        e.stopPropagation();
        log("[PoC] Hotkey Alt + Z (solve)");
        solveCurrentPoC();
        return;
      }

      if (k === "X" || code === "KeyX") {
        e.preventDefault();
        e.stopPropagation();
        if (overlay.visible) {
          log("[PoC] Hotkey Alt + X (hide panel)");
          hideOverlay();
        } else {
          log("[PoC] Hotkey Alt + X (show answer panel)");
          overlayCurrentPoC();
        }
        return;
      }
    };

    window.addEventListener("keydown", window.__ppsKeyHandler, true);
  }

  // ─── Popup messages ───────────────────────────────────────────────────────
  window.addEventListener("message", function (event) {
    if (
      event.data?.type === "__PPS_TRIGGER_POC__" ||
      event.data?.type === "__PPS_AI_FILL__"
    ) {
      solveCurrentPoC();
    }
  });

  // ─── Init ─────────────────────────────────────────────────────────────────
  function init() {
    interceptXHR();
    interceptFetch();
    watchForUrlChange();
    setupHotkey();
    log(`PPS Instatest PoC Ready | build ${BUILD} | Alt+Z solve · Alt+X answer panel · Alt+↑/↓ step`);
  }

  init();
})();