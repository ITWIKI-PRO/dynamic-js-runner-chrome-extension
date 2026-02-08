const DEFAULT_STATE = {
  enabled: true,
  // rules: [{ id, name, enabled, pattern, code, runAt: "document_idle"|"document_end"|"document_start", world:"MAIN"|"ISOLATED" }]
  rules: []
};

// Track recent injections to avoid duplicate injections for the same tab+rule
const _recentInjections = new Map(); // tabId -> Map(ruleId -> timestamp)
function _shouldInject(tabId, ruleId, windowMs = 3000) {
  try {
    let m = _recentInjections.get(tabId);
    const now = Date.now();
    if (!m) {
      m = new Map();
      _recentInjections.set(tabId, m);
    }
    const last = m.get(ruleId) || 0;
    if (now - last < windowMs) return false;
    m.set(ruleId, now);
    // cleanup old entries
    for (const [k, v] of m.entries()) if (now - v > 60000) m.delete(k);
    return true;
  } catch (e) { return true; }
}

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
    world: rule.world ?? "MAIN",
    blockingHead: rule.blockingHead ?? false
  };
}

async function injectRule(tabId, rule) {
  const code = String(rule.code || "");
  if (!code.trim()) return;
  const baseWrapped = `(async () => {\n${code}\n})().catch(e => console.error('[ITW JS] Script error:', e));`;
  // Prepend a visible marker so we can observe which injection actually ran in page console
  const marker = `console.info('[ITW JS RUN]', ${JSON.stringify(rule.id)}, 'runAt', ${JSON.stringify(rule.runAt)});\n`;
  const wrapped = marker + baseWrapped;

  try {
    if (rule.runAt === "document_head") {
      // avoid duplicate injection for same tab+rule
      if (!_shouldInject(tabId, rule.id)) {
        console.debug('[ITW JS] skip duplicate head injection', rule.id, 'tab', tabId);
        return;
      }
      console.debug('[ITW JS] injecting (head) rule (via executeScript)', rule.id, 'tab', tabId);
      // Ensure head injections run in the page context (MAIN) so they can interact with head.
      const execWorldHead = 'MAIN';
      console.debug('[ITW JS] execWorld for head', execWorldHead);
      await chrome.scripting.executeScript({
        target: { tabId },
        world: execWorldHead,
        injectImmediately: true,
        func: (src) => {
          // eslint-disable-next-line no-new-func
          const fn = new Function(src);
          return fn();
        },
        args: [wrapped]
      });
      console.debug('[ITW JS] injected (head) rule', rule.id);
      return;
    }

    // avoid duplicate injection for same tab+rule
    if (!_shouldInject(tabId, rule.id)) {
      console.debug('[ITW JS] skip duplicate injection', rule.id, 'tab', tabId);
      return;
    }
    // Use the rule's configured world (MAIN by default) — restore previous behavior
    const execWorld = rule.world === "ISOLATED" ? "ISOLATED" : "MAIN";
    console.debug('[ITW JS] injecting rule', rule.id, 'tab', tabId, 'runAt', rule.runAt, 'execWorld', execWorld);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: execWorld,
      injectImmediately: rule.runAt === "document_start",
      func: (src) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function(src);
        return fn();
      },
      args: [wrapped]
    });
    console.debug('[ITW JS] injected rule', rule.id);
  } catch (err) {
    console.error('[ITW JS] injectRule error for', rule.id, err);
  }
}

async function handleTab(tabId, url, reason) {
  if (!url) return;
  if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:")) return;

  const st = await getState();
  if (!st.enabled) return;
  console.debug('[ITW JS] handleTab', { tabId, url, reason });

  const rules = st.rules.map(normalizeRule).filter(r => r.enabled);
  const matched = rules.filter(r => {
    try { return urlMatchesRule(r, url); } catch { return false; }
  });

  console.debug('[ITW JS] matched rules', matched.map(r => ({ id: r.id, runAt: r.runAt })));

  for (const rule of matched) {
    try {
      // Only inject rules that match the current navigation phase.
      // - during loading: inject rules meant for document_start or document_head
      // - on complete: inject rules meant for document_end or document_idle
      if (reason === 'onUpdated.loading') {
        if (rule.runAt === 'document_start' || rule.runAt === 'document_head') {
          await injectRule(tabId, rule);
        }
      } else {
        // default to complete: handle document_end / document_idle
        if (rule.runAt === 'document_end' || rule.runAt === 'document_idle') {
          await injectRule(tabId, rule);
        }
      }
    } catch (e) {
      console.warn("[ITW JS] Failed to inject rule", rule.id, "reason:", reason, e);
    }
  }
}

// Listen for both loading and complete events so we can inject at document_start (loading)
// as well as document_end/document_idle (complete).
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab?.url) return;
  if (changeInfo.status === "loading") {
    await handleTab(tabId, tab.url, "onUpdated.loading");
  } else if (changeInfo.status === "complete") {
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
