// offscreen.js — Runs in offscreen document to make cross-origin API calls
// (service workers cannot perform cross-origin fetch with custom headers)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "__PPS_OFFSCREEN_FETCH__") {
    handleFetch(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message || String(err) }));
    return true;
  }
});

async function handleFetch({ url, headers, body }) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`API ${res.status}: ${text.slice(0, 300)}`);
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response: ${text.slice(0, 300)}`);
  }
}