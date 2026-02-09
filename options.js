const $ = (id) => document.getElementById(id);

// Notification System
function showNotification(message, type = 'success', duration = 3000) {
  const container = $('notificationContainer');
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠'
  };

  notification.innerHTML = `
    <div class="notification-icon">${icons[type] || icons.info}</div>
    <div class="notification-content">
      <div class="notification-title">${escapeHtml(message)}</div>
    </div>
    <div class="notification-close">×</div>
  `;

  const closeBtn = notification.querySelector('.notification-close');
  closeBtn.addEventListener('click', () => {
    notification.classList.add('removing');
    setTimeout(() => notification.remove(), 300);
  });

  container.appendChild(notification);

  if (duration > 0) {
    setTimeout(() => {
      if (notification.parentNode) {
        notification.classList.add('removing');
        setTimeout(() => notification.remove(), 300);
      }
    }, duration);
  }
}

// Confirmation Dialog
function showConfirm(title, message) {
  return new Promise((resolve) => {
    let overlay = $('confirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'modalOverlay';
      document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title">${escapeHtml(title)}</div>
        <div class="modal-text">${escapeHtml(message)}</div>
        <div class="modal-buttons">
          <button id="confirmCancel" class="secondary">Отмена</button>
          <button id="confirmOk" class="danger">Удалить</button>
        </div>
      </div>
    `;

    overlay.classList.add('active');

    const handleConfirm = () => {
      overlay.classList.remove('active');
      resolve(true);
    };

    const handleCancel = () => {
      overlay.classList.remove('active');
      resolve(false);
    };

    $('confirmOk').addEventListener('click', handleConfirm);
    $('confirmCancel').addEventListener('click', handleCancel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) handleCancel();
    });
  });
}

let state = { enabled: true, rules: [] };
let selectedId = null;

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

async function loadState() {
  const st = await chrome.storage.local.get(null);
  state.enabled = st.enabled !== false;
  state.rules = Array.isArray(st.rules) ? st.rules.map(normalizeRule) : [];
}

async function saveState() {
  await chrome.storage.local.set({ enabled: state.enabled, rules: state.rules });
}

function renderList() {
  const root = $("rules");
  root.innerHTML = "";
  if (!state.rules.length) {
    root.innerHTML = `<div style="opacity:.8;font-size:13px;line-height:1.4;padding:8px;">
      Правил пока нет. Нажмите «Добавить правило».
    </div>`;
    return;
  }

  for (const r of state.rules) {
    const el = document.createElement("div");
    el.className = "ruleItem";
    el.dataset.id = r.id;

    const title = (r.name && r.name.trim()) ? r.name.trim() : "(без названия)";
    const type = (r.patternType === "regex") ? "REGEX" : "Chrome";
    const runAtLabel =
      r.runAt === "document_head" ? "HEAD" :
        r.runAt === "document_start" ? "START" :
          r.runAt === "document_end" ? "END" : "IDLE";
    const headStyle = r.runAt === "document_head" ? "background-color: #c41e3a;" : "";
    el.innerHTML = `
    <div class="pill-container">
      <div class="pill">${type}</div>
      <div class="pill" style="${headStyle}">${runAtLabel}</div>
    </div>
      <div class="ruleMain">
        <div class="ruleTitle">${escapeHtml(title)}</div>
        <div class="ruleSub">${escapeHtml(r.pattern)}</div>
      </div>
      <input class="ruleToggle" type="checkbox" ${r.enabled ? "checked" : ""} title="Вкл/выкл" />
    `;

    el.querySelector(".ruleToggle").addEventListener("click", async (e) => {
      e.stopPropagation();
      r.enabled = e.target.checked;
      await saveState();
      renderList();
      if (selectedId === r.id) $("ruleEnabled").checked = r.enabled;
      const statusText = r.enabled ? "включено" : "отключено";
      showNotification(`Правило ${statusText}`, "info", 2000);
    });

    el.addEventListener("click", () => selectRule(r.id));
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openRuleMenu(event.clientX, event.clientY, r);
    });
    root.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

const jsKeywords = new Set([
  "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "let", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var",
  "void", "while", "with", "yield"
]);

function escapeHtmlChunk(value) {
  return value.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

function highlightCode(code) {
  let output = "";
  let i = 0;

  const isIdentifierStart = (ch) => /[A-Za-z_$]/.test(ch);
  const isIdentifierPart = (ch) => /[A-Za-z0-9_$]/.test(ch);
  const isDigit = (ch) => /[0-9]/.test(ch);
  const operatorChars = new Set(["=", "+", "-", "*", "%", "<", ">", "!", "&", "|", "^", "~", "?", ":", "."]);

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === "/" && next === "/") {
      let end = i + 2;
      while (end < code.length && code[end] !== "\n") end += 1;
      const comment = code.slice(i, end);
      output += `<span class="token-comment">${escapeHtmlChunk(comment)}</span>`;
      i = end;
      continue;
    }

    if (ch === "/" && next === "*") {
      let end = i + 2;
      while (end < code.length && !(code[end] === "*" && code[end + 1] === "/")) {
        end += 1;
      }
      end = Math.min(end + 2, code.length);
      const comment = code.slice(i, end);
      output += `<span class="token-comment">${escapeHtmlChunk(comment)}</span>`;
      i = end;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let end = i + 1;
      let escaped = false;
      while (end < code.length) {
        const current = code[end];
        if (!escaped && current === quote) {
          end += 1;
          break;
        }
        escaped = !escaped && current === "\\";
        end += 1;
      }
      const str = code.slice(i, end);
      output += `<span class="token-string">${escapeHtmlChunk(str)}</span>`;
      i = end;
      continue;
    }

    if (isDigit(ch)) {
      let end = i + 1;
      while (end < code.length && /[0-9a-fA-FxXbBoO._]/.test(code[end])) {
        end += 1;
      }
      const number = code.slice(i, end);
      output += `<span class="token-number">${escapeHtmlChunk(number)}</span>`;
      i = end;
      continue;
    }

    if (isIdentifierStart(ch)) {
      let end = i + 1;
      while (end < code.length && isIdentifierPart(code[end])) {
        end += 1;
      }
      const word = code.slice(i, end);
      if (jsKeywords.has(word)) {
        output += `<span class="token-keyword">${escapeHtmlChunk(word)}</span>`;
      } else {
        output += `<span class="token-identifier">${escapeHtmlChunk(word)}</span>`;
      }
      i = end;
      continue;
    }

    if (operatorChars.has(ch)) {
      output += `<span class="token-operator">${escapeHtmlChunk(ch)}</span>`;
      i += 1;
      continue;
    }

    output += escapeHtmlChunk(ch);
    i += 1;
  }

  return output;
}

function syncCodeHighlight() {
  const input = $("code");
  const highlight = $("codeHighlight");
  if (!input || !highlight) return;
  highlight.innerHTML = `${highlightCode(input.value)}\n`;
  highlight.scrollTop = input.scrollTop;
  highlight.scrollLeft = input.scrollLeft;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function closeRuleMenu() {
  const menu = $("ruleMenu");
  menu.classList.remove("open");
  menu.setAttribute("aria-hidden", "true");
  menu.dataset.ruleId = "";
  menu.dataset.enabled = "";
}

function openRuleMenu(x, y, rule) {
  const menu = $("ruleMenu");
  const toggleButton = $("menuToggle");
  const label = rule.enabled ? "Отключить" : "Включить";
  toggleButton.textContent = label;
  menu.dataset.ruleId = rule.id;
  menu.dataset.enabled = String(rule.enabled);
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");

  const { innerWidth, innerHeight } = window;
  const rect = menu.getBoundingClientRect();
  const left = clamp(x, 8, innerWidth - rect.width - 8);
  const top = clamp(y, 8, innerHeight - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function clearEditor() {
  selectedId = null;
  $("name").value = "";
  $("patternType").value = "match";
  $("pattern").value = "*://*/*";
  updatePatternHelp();
  $("runAt").value = "document_idle";
  $("world").value = "MAIN";
  $("code").value = "";
  syncCodeHighlight();
  $("ruleEnabled").checked = true;
  $("deleteRule").disabled = true;
}

function selectRule(id) {
  const r = state.rules.find(x => x.id === id);
  if (!r) return;
  selectedId = id;
  $("name").value = r.name ?? "";
  $("patternType").value = r.patternType ?? "match";
  $("pattern").value = r.pattern ?? "*://*/*";
  updatePatternHelp();
  $("runAt").value = r.runAt ?? "document_idle";
  $("world").value = r.world ?? "MAIN";
  $("code").value = r.code ?? "";
  syncCodeHighlight();
  $("ruleEnabled").checked = r.enabled !== false;
  $("deleteRule").disabled = false;
}

$("addRule").addEventListener("click", () => {
  const rule = normalizeRule({ name: "Новое правило", patternType: "match", pattern: "*://*/*", code: "" });
  state.rules.unshift(rule);
  selectedId = rule.id;
  renderList();
  selectRule(rule.id);
  showNotification("Новое правило создано", "success");
});

$("saveRule").addEventListener("click", async () => {
  if (!selectedId) return;
  const r = state.rules.find(x => x.id === selectedId);
  if (!r) return;

  r.name = $("name").value;
  r.patternType = $("patternType").value;
  r.pattern = $("pattern").value || (r.patternType === "regex" ? ".*" : "*://*/*");
  r.runAt = $("runAt").value;
  r.world = $("world").value;
  r.code = $("code").value;
  r.enabled = $("ruleEnabled").checked;
  r.blockingHead = r.runAt === "document_head";

  await saveState();
  renderList();
  showNotification("Правило сохранено", "success");
});

$("deleteRule").addEventListener("click", async () => {
  if (!selectedId) return;
  const r = state.rules.find(x => x.id === selectedId);
  if (!r) return;

  const confirmed = await showConfirm(
    "Удалить правило?",
    `Вы уверены, что хотите удалить правило "${escapeHtml(r.name || '(без названия)')}"`
  );

  if (!confirmed) return;

  state.rules = state.rules.filter(x => x.id !== selectedId);
  await saveState();
  renderList();
  clearEditor();
  showNotification("Правило удалено", "success");
});

document.addEventListener("click", (event) => {
  const menu = $("ruleMenu");
  if (!menu.classList.contains("open")) return;
  if (menu.contains(event.target)) return;
  closeRuleMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeRuleMenu();
  }
});

window.addEventListener("blur", () => {
  closeRuleMenu();
});

$("menuToggle").addEventListener("click", async () => {
  const menu = $("ruleMenu");
  const ruleId = menu.dataset.ruleId;
  const enabled = menu.dataset.enabled === "true";
  if (!ruleId) return;
  const rule = state.rules.find(x => x.id === ruleId);
  if (!rule) return;
  rule.enabled = !enabled;
  await saveState();
  renderList();
  if (selectedId === rule.id) $("ruleEnabled").checked = rule.enabled;
  const message = enabled ? "Правило отключено" : "Правило включено";
  showNotification(message, "info");
  closeRuleMenu();
});

$("menuDelete").addEventListener("click", async () => {
  const menu = $("ruleMenu");
  const ruleId = menu.dataset.ruleId;
  if (!ruleId) return;
  const rule = state.rules.find(x => x.id === ruleId);
  if (!rule) return;
  const confirmed = await showConfirm(
    "Удалить правило?",
    `Вы уверены, что хотите удалить правило "${escapeHtml(rule.name || '(без названия)')}"`
  );
  if (!confirmed) return;
  state.rules = state.rules.filter(x => x.id !== ruleId);
  await saveState();
  renderList();
  if (selectedId === ruleId) {
    clearEditor();
    if (state.rules.length) selectRule(state.rules[0].id);
  }
  showNotification("Правило удалено", "success");
  closeRuleMenu();
});

$("exportRules").addEventListener("click", async () => {
  const payload = { version: 1, exportedAt: new Date().toISOString(), enabled: state.enabled, rules: state.rules };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "dynamic-js-runner-rules.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
  showNotification("Правила экспортированы", "success");
});

$("patternType").addEventListener("change", updatePatternHelp);

const codeInput = $("code");
if (codeInput) {
  codeInput.addEventListener("input", syncCodeHighlight);
  codeInput.addEventListener("scroll", syncCodeHighlight);
  codeInput.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const start = codeInput.selectionStart;
    const end = codeInput.selectionEnd;
    const value = codeInput.value;
    const indent = "  ";

    if (event.shiftKey && start === end && value.slice(start - indent.length, start) === indent) {
      codeInput.value = value.slice(0, start - indent.length) + value.slice(end);
      codeInput.selectionStart = start - indent.length;
      codeInput.selectionEnd = start - indent.length;
    } else {
      codeInput.value = value.slice(0, start) + indent + value.slice(end);
      codeInput.selectionStart = start + indent.length;
      codeInput.selectionEnd = start + indent.length;
    }

    syncCodeHighlight();
  });
}

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.rules)) throw new Error("Неверный формат.");
    state.enabled = obj.enabled !== false;
    state.rules = obj.rules.map(normalizeRule);
    await saveState();
    renderList();
    clearEditor();
    showNotification(`Импортировано ${state.rules.length} правил`, "success");
  } catch (err) {
    showNotification("Ошибка импорта: " + (err?.message ?? err), "error", 5000);
  } finally {
    e.target.value = "";
  }
});

async function init() {
  await loadState();
  await saveState(); // persist normalization if needed
  const draftId = await applyDraftFromSession();
  renderList();
  clearEditor();

  // Проверяем, если нужно выбрать конкретное правило из popup
  const session = await chrome.storage.session.get(['selectedRuleId']);
  if (draftId && state.rules.some(r => r.id === draftId)) {
    selectRule(draftId);
  } else if (session.selectedRuleId && state.rules.some(r => r.id === session.selectedRuleId)) {
    selectRule(session.selectedRuleId);
    // Очищаем selectedRuleId из session
    await chrome.storage.session.remove('selectedRuleId');
  } else if (state.rules.length) {
    selectRule(state.rules[0].id);
  }
}

init();

async function applyDraftFromSession() {
  const session = await chrome.storage.session.get(['createRuleDraft']);
  if (!session.createRuleDraft) return null;
  await chrome.storage.session.remove('createRuleDraft');
  const draft = session.createRuleDraft;
  const rule = normalizeRule({
    name: draft?.name ?? "Новое правило",
    patternType: draft?.patternType ?? "match",
    pattern: draft?.pattern ?? "*://*/*",
    code: draft?.code ?? ""
  });
  state.rules.unshift(rule);
  selectedId = rule.id;
  showNotification("Новое правило создано", "success");
  await saveState();
  return rule.id;
}
function updatePatternHelp() {
  const t = $("patternType")?.value ?? "match";
  const help = $("patternHelp");
  const pattern = $("pattern");
  if (!help || !pattern) return;

  if (t === "regex") {
    help.innerHTML = 'Примеры (Regex): <code>^https?://(www\\.)?example\\.com/.*$</code> или <code>/^https?:\\/\\/example\\.com\\//i</code>';
    pattern.placeholder = "^https?://(www\\.)?example\\.com/.*$";
  } else {
    help.innerHTML = 'Примеры (Chrome): <code>*://*/*</code>, <code>https://example.com/*</code>, <code>*://*.google.com/*</code>';
    pattern.placeholder = "*://*.example.com/*";
  }
}
