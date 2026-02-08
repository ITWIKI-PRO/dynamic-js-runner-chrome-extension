const DEFAULT_STATE = {
  enabled: true,
  // rules: [{ id, name, enabled, pattern, code, runAt: "document_idle"|"document_end"|"document_start", world:"MAIN"|"ISOLATED" }]
  rules: []
};

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(null);
  if (!cur || Object.keys(cur).length === 0) {
    await chrome.storage.local.set(DEFAULT_STATE);
  } else {
    const patch = {};
    if (cur.enabled === undefined) patch.enabled = true;
    if (!Array.isArray(cur.rules)) patch.rules = [];
    if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  }
});

// --- Match-pattern helper (supports Chrome match patterns like *://*.example.com/*) ---
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchPatternToRegExp(pattern) {
  if (pattern === "<all_urls>") return /^(https?|file|ftp|ws|wss):\/\/.+$/i;

  const m = /^(?:(\*|http|https|file|ftp|ws|wss):\/\/)(\*|\*\.[^\/]+|[^\/]+)(\/.*)$/.exec(pattern);
  if (!m) return null;

  const scheme = m[1];
  const host = m[2];
  const path = m[3];

  let re = "^";
  if (scheme === "*") re += "(?:http|https|file|ftp|ws|wss)";
  else re += escapeRegex(scheme);

  re += ":\\/\\/";

  if (host === "*") re += "[^\\/]+";
  else if (host.startsWith("*.")) re += "(?:[^\\/]+\\.)?" + escapeRegex(host.slice(2));
  else re += escapeRegex(host);

  re += escapeRegex(path).replace(/\\\*/g, ".*");
  re += "$";
  return new RegExp(re, "i");
}

function urlMatchesRule(rule, url) {
  const patternType = rule?.patternType ?? "match";
  const pattern = String(rule?.pattern ?? "");
  if (!pattern) return false;

  try {
    if (patternType === "regex") {
      // Accept either "/.../flags" or plain pattern (defaults to i)
      let source = pattern;
      let flags = "i";
      const m = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(pattern);
      if (m) { source = m[1]; flags = m[2] || "i"; }
      return new RegExp(source, flags).test(url);
    }

    // match-pattern mode (legacy)
    const re = matchPatternToRegExp(pattern);
    return !!re && re.test(url);
  } catch {
    return false;
  }
}

async function getState() {
  const st = await chrome.storage.local.get(null);
  return {
    enabled: st.enabled !== false,
    rules: Array.isArray(st.rules) ? st.rules : []
  };
}

function normalizeRule(rule) {
  return {
    id: rule.id ?? crypto.randomUUID(),
    name: rule.name ?? "",
    enabled: rule.enabled !== false,
    pattern: rule.pattern ?? "*://*/*",
    patternType: rule.patternType ?? "match",
    code: rule.code ?? "",
    runAt: rule.runAt ?? "document_idle",
    world: rule.world ?? "MAIN"
  };
}

async function injectRule(tabId, rule) {
  const code = String(rule.code || "");
  if (!code.trim()) return;

  const wrapped = `(async () => {\n${code}\n})().catch(e => console.error('[ITW JS] Script error:', e));`;

  await chrome.scripting.executeScript({
    target: { tabId },
    world: rule.world === "ISOLATED" ? "ISOLATED" : "MAIN",
    injectImmediately: rule.runAt === "document_start",
    func: (src) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(src);
      return fn();
    },
    args: [wrapped]
  });
}

async function handleTab(tabId, url, reason) {
  if (!url) return;
  if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:")) return;

  const st = await getState();
  if (!st.enabled) return;

  const rules = st.rules.map(normalizeRule).filter(r => r.enabled);
  const matched = rules.filter(r => {
    try { return urlMatchesRule(r, url); } catch { return false; }
  });

  for (const rule of matched) {
    try {
      await injectRule(tabId, rule);
    } catch (e) {
      console.warn("[ITW JS] Failed to inject rule", rule.id, "reason:", reason, e);
    }
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab?.url) {
    await handleTab(tabId, tab.url, "onUpdated.complete");
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "GET_STATE") {
      const st = await getState();
      sendResponse({ ok: true, state: st });
      return;
    }
    if (msg.type === "SET_ENABLED") {
      await chrome.storage.local.set({ enabled: !!msg.enabled });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "RUN_NOW") {
      const tabId = msg.tabId ?? sender?.tab?.id;
      const url = msg.url ?? sender?.tab?.url;
      if (!tabId || !url) {
        sendResponse({ ok: false, error: "No active tab." });
        return;
      }
      await handleTab(tabId, url, "run_now");
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "Unknown message." });
  })().catch(e => {
    sendResponse({ ok: false, error: String(e?.message ?? e) });
  });
  return true;
});
