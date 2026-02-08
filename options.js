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
    world: rule.world ?? "MAIN"
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
    const type = (r.patternType === "regex") ? "REGEX" : "MATCH";
    el.innerHTML = `
      <div class="pill">${r.enabled ? "ON" : "OFF"}</div>
      <div class="pill">${type}</div>
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
    root.appendChild(el);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
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
  renderList();
  clearEditor();
  if (state.rules.length) selectRule(state.rules[0].id);
}

init();
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


