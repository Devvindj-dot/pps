// background.js — Service Worker
// Routes AI requests through an offscreen document (service workers cannot
// perform cross-origin fetch with custom headers).

let creatingOffscreen = null;

// ─── OpenCode Free-Tier Session ID (UUID4, once per service worker lifecycle) ──
function generateUUID4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const OPCODE_SESSION_ID = generateUUID4();

async function ensureOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });

  if (existingContexts.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Fetch OpenAI-compatible API (service worker CORS limitation)",
    });
  }
  await creatingOffscreen;
  creatingOffscreen = null;

  // Wait for offscreen script to register its message listener
  await new Promise((r) => setTimeout(r, 100));
}

async function removeOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });
  if (existingContexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

// ─── Message Router ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "__PPS_AI_REQUEST__") {
    handleAIRequest(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }

  if (msg.type === "__PPS_GET_SETTINGS__") {
    chrome.storage.local.get(["apiKey", "baseUrl", "model"], (data) =>
      sendResponse({
        apiKey: data.apiKey || "",
        baseUrl: data.baseUrl || "https://api.openai.com/v1",
        model: data.model || "gpt-4o-mini",
      })
    );
    return true;
  }
});

// ─── AI Request via Offscreen Document ─────────────────────────────────────

async function handleAIRequest({ question, settings }) {
  const { apiKey, baseUrl, model } = settings;

  if (!apiKey) {
    return {
      error:
        "No API key configured. Open the extension popup and set your credentials.",
    };
  }

  const systemPrompt = buildSystemPrompt(question);
  const userPrompt = buildUserPrompt(question);
  const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

  const headers = { "Content-Type": "application/json" };

  if (baseUrl.includes("opencode.ai")) {
    // Free-tier: empty Authorization (no Bearer token), session ID is the auth gate
    headers["Authorization"] = "";
    headers["X-Session-ID"] = OPCODE_SESSION_ID;
    headers["HTTP-Referer"] = "https://opencode.ai/";
    headers["X-Title"] = "opencode";
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  await ensureOffscreen();

  const response = await chrome.runtime.sendMessage({
    type: "__PPS_OFFSCREEN_FETCH__",
    url,
    headers,
    body: {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    },
  });

  await removeOffscreen();

  if (response?.error) {
    throw new Error(response.error);
  }

  const content = response?.choices?.[0]?.message?.content || "";
  return { answer: content.trim() };
}

// ─── Prompt Construction ───────────────────────────────────────────────────

function qType(question) {
  const t = (question.type || question.questionType || "").toUpperCase();
  if (t === "MCQ") return "MCQ";
  if (t === "DESCRIPTIVE") return "DESCRIPTIVE";
  return "CODING";
}

function buildSystemPrompt(question) {
  const type = qType(question);

  if (type === "CODING") {
    const lang = resolveLanguage(question);
    const isSignatureMode = question.coding_mode === "FUNCTION_SIGNATURE";
    const rules = [
      `You are an expert ${lang} programmer solving a competitive-programming question.`,
      "The platform compiles the EDITABLE REGION of the editor between a fixed prefix",
      "(imports / class header) and a fixed suffix (the main driver). Only the editable",
      "region is sent to the compiler, and it ALREADY provides the main driver.",
      "",
      "You will be given the complete current editor buffer:",
      "  PREFIX (fixed, read-only) + EDITABLE REGION + SUFFIX (fixed, read-only)",
      "",
      "Rules you MUST follow:",
      "1. Return ONLY the editable region: its exact first line, plus the body.",
      "2. The PREFIX is provided and read-only (it may declare imports and helper",
      "   classes such as `TreeNode`). Never include or redefine it.",
      "3. The SUFFIX is provided and read-only (the main driver). Never include it.",
      "4. Do NOT add a main function, input parsing or printing of your own.",
      "5. Use any type declared in the prefix exactly as declared — pay attention to",
      "   whether members are pointers, references or values.",
      "6. Preserve the function name, parameter names/types and return type EXACTLY.",
      "7. Do NOT use markdown fences and do NOT add any explanation or commentary.",
    ];

    if (!isSignatureMode) {
      rules.push(
        "",
        "NOTE: this question has no fixed prefix/suffix, so instead return the COMPLETE",
        "self-contained program (reads STDIN, writes STDOUT) and nothing else."
      );
    }

    return rules.join("\n");
  }

  if (type === "DESCRIPTIVE") {
    return [
      "You are answering a descriptive / written-answer question.",
      "Answer directly and completely. Use plain text with short paragraphs or bullet points.",
      "Return ONLY the answer text, no markdown fences, no preamble like \"Answer:\".",
    ].join(" ");
  }

  const multi = !!(question.isMultiCorrect || question.isMultiSelect);
  return [
    "You are answering a multiple-choice question.",
    multi
      ? "This question may have MULTIPLE correct options. Reply with ONLY the letters of all correct options, comma-separated (for example: A,C)."
      : "This question has exactly ONE correct option. Reply with ONLY that letter.",
    "Just the letter(s), nothing else.",
  ].join(" ");
}

function buildUserPrompt(question) {
  const type = qType(question);
  const title = question.name || question.title || "";
  const description = stripHtml(question.description || question.body || "");

  let prompt = "";
  if (title) prompt += `Question: ${title}\n`;
  if (description) prompt += `${description}\n`;

  if (type === "CODING") {
    const lang = resolveLanguage(question);
    const isSignatureMode = question.coding_mode === "FUNCTION_SIGNATURE";
    const starter = resolveStarterCode(question, lang);
    prompt += `\nLanguage: ${lang}\n`;
    if (starter) {
      const what = isSignatureMode
        ? "editor buffer = PREFIX + [EDITABLE REGION] + SUFFIX"
        : "editor buffer";
      prompt += `\nCurrent ${what} (return ONLY the editable region with the signature implemented):\n\`\`\`\n${starter}\n\`\`\`\n`;
if (isSignatureMode) {
          const entry = boilerplateEntry(question, lang);
          if (entry) {
            // The editable region can start with a class declaration
            // (e.g. `class Solution {`), so pin down the exact first line.
            const region = editableRegion(starter, entry);
            const firstLine = region.split("\n").find((l) => l.trim().length > 0) || "";
            if (firstLine) {
              prompt += `\nYour answer MUST begin with this exact line (it is the first line of the editable region):\n${firstLine}\n`;
            }
            prompt +=
              "\nIMPORTANT: any class/struct/helper already shown in the PREFIX (for example" +
              " `TreeNode`) is provided by the platform.\nUse those types exactly as declared" +
              " (note whether members are pointers or values) and do NOT redefine them.\n";
            prompt += `\nThe SUFFIX (main driver) is also provided — do not repeat it:\n\`\`\`\n${entry.suffix || ""}\n\`\`\`\n`;
          }
        }
    } else {
      prompt += `\nWrite a complete ${lang} program that reads from STDIN and writes to STDOUT.\n`;
    }
    const samples = question.sample_test_cases || question.sampleTestCases || [];
    if (Array.isArray(samples) && samples.length > 0) {
      prompt += "\nSample test cases:\n";
      samples.slice(0, 3).forEach((t, i) => {
        prompt += `Case ${i + 1}:\nInput:\n${t.input}\nExpected Output:\n${t.output}\n`;
      });
    }
  } else if (type === "DESCRIPTIVE") {
    const limit = question.characterLimit;
    if (limit) prompt += `\nKeep the answer under ${limit} characters.\n`;
  } else {
    const options = question.options || [];
    if (options.length > 0) {
      prompt += "\nOptions:\n";
      options.forEach((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        prompt += `${letter}) ${stripHtml(opt.value ?? opt.text ?? "")}\n`;
      });
    }
  }

  return prompt.trim();
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const LANGUAGE_NAMES = {
  python: "Python",
  cpp: "C++",
  csharp: "C#",
  java: "Java",
  javascript: "JavaScript",
  go: "Go",
  swift: "Swift",
  scala: "Scala",
  c: "C",
  typescript: "TypeScript",
  kotlin: "Kotlin",
  ruby: "Ruby",
  php: "PHP",
};

// Maps the platform's display names to the keys used in `boilerplate_languages`
const DISPLAY_TO_KEY = {
  "c++": "cpp",
  "c#": "csharp",
  "python3": "python",
};

function resolveLanguage(question) {
  const explicit =
    question.language || question.lang || (question.currentLanguage ? question.currentLanguage : null);
  if (explicit) {
    const key = DISPLAY_TO_KEY[String(explicit).toLowerCase()] || String(explicit).toLowerCase();
    return LANGUAGE_NAMES[key] || explicit;
  }
  // The platform's editor defaults to C++ (localStorage "lastUsedLanguage").
  return "C++";
}

// Returns { prefix, placeholder, suffix } for the requested language, or null.
function stripTrailingNewlines(s) {
  return (s == null ? "" : String(s)).replace(/\n+$/, "");
}

function stripLeadingNewlines(s) {
  return (s == null ? "" : String(s)).replace(/^\n+/, "");
}

// Reproduce the site's own stripping so we can talk about the editable region.
function editableRegion(fullBuffer, entry) {
  if (!entry) return fullBuffer;
  const prefix = stripTrailingNewlines(entry.prefix);
  const suffix = stripLeadingNewlines(entry.suffix);
  const prefixLines = prefix ? prefix.split("\n").length : 0;
  const suffixLines = suffix ? suffix.split("\n").length : 0;
  const lines = String(fullBuffer).split("\n");
  return lines
    .slice(prefixLines, suffixLines > 0 ? lines.length - suffixLines : undefined)
    .join("\n");
}

function boilerplateEntry(question, langName) {
  const boiler = question.boilerplate_languages || question.boilerplateLanguages;
  if (!boiler || typeof boiler !== "object") return null;

  const key = String(langName).toLowerCase();
  const entry =
    boiler[key] || boiler[DISPLAY_TO_KEY[key]] || boiler[String(langName)] || null;

  if (!entry || typeof entry !== "object") return null;
  return entry;
}

function resolveStarterCode(question, langName) {
  // Highest priority: the live editor buffer captured by content.js
  const live = question.currentCode || question.starterCode || question.starter_code;
  if (live) return live;

  const boiler = question.boilerplate_languages || question.boilerplateLanguages;

  if (boiler && typeof boiler === "object" && Object.keys(boiler).length > 0) {
    const key = String(langName).toLowerCase();
    const entry =
      boiler[key] || boiler[DISPLAY_TO_KEY[key]] || boiler[Object.keys(boiler)[0]] || null;

    if (typeof entry === "string") return entry;

    // Real shape: { prefix, placeholder, suffix } — reassemble the editor buffer
    if (entry && typeof entry === "object") {
      return [entry.prefix, entry.placeholder || "", entry.suffix]
        .filter((part) => typeof part === "string" && part.length > 0)
        .join("\n");
    }
  }

  return "";
}

function stripHtml(input) {
  if (!input) return "";
  if (typeof input !== "string") return String(input);

  // Quill delta: { ops: [ { insert: "text" } ] }
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && Array.isArray(parsed.ops)) {
        return parsed.ops
          .map((op) => (typeof op.insert === "string" ? op.insert : ""))
          .join("")
          .replace(/\n/g, " ")
          .trim();
      }
    } catch (e) {
      /* fall through to HTML strip */
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}