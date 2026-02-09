const $ = (id) => document.getElementById(id);

// Simple notification for popup
function showNotification(message, type = 'success') {
  const statusLine = $("statusLine");
  const colors = {
    success: '#2dd64a',
    error: '#ff7675',
    info: '#58cef5'
  };
  const originalColor = statusLine.style.color;
  const originalText = statusLine.textContent;
  
  statusLine.style.color = colors[type] || colors.info;
  statusLine.textContent = message;
  
  setTimeout(() => {
    statusLine.style.color = originalColor;
    statusLine.textContent = originalText;
  }, 3000);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function urlMatchesRule(rule, url) {
  try {
    const patternType = rule?.patternType ?? "match"; // default: как было раньше
    const pattern = String(rule?.pattern ?? "");
    if (!pattern) return false;

    if (patternType === "regex") {
      // поддержка "/.../flags" или просто шаблон (по умолчанию i)
      let source = pattern;
      let flags = "i";
      const m = /^\/([\s\S]+)\/([gimsuy]*)$/.exec(pattern);
      if (m) {
        source = m[1];
        flags = m[2] || "i";
      }
      return new RegExp(source, flags).test(url);
    }

    // match pattern (старый режим)
    return urlMatches(pattern, url); // если urlMatches у вас ниже/выше — оставьте и используйте
  } catch {
    return false;
  }
}

async function refresh() {
  const tab = await getActiveTab();
  $("url").textContent = tab?.url ?? "—";

  const resp = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!resp?.ok) return;

  const state = resp.state;
  $("enabled").checked = !!state.enabled;

  const rules = Array.isArray(state.rules) ? state.rules : [];
  const url = tab?.url ?? "";
  const matched = url ? rules.filter(r => urlMatchesRule(r, url)) : [];
  
  // Обновляем список скриптов
  const scriptsList = $("scriptsList");
  const noScripts = $("noScripts");
  
  if (matched.length === 0) {
    scriptsList.innerHTML = "";
    noScripts.style.display = "block";
  } else {
    noScripts.style.display = "none";
    scriptsList.innerHTML = matched
      .map(rule => {
        const name = rule.name || "(без названия)";
        const disabled = rule.enabled === false;
        const status = disabled ? `<div class="script-state">Отключен</div>` : "";
        const classes = disabled ? "script-item is-disabled" : "script-item";
        return `<div class="${classes}" data-rule-id="${rule.id}" data-enabled="${!disabled}" title="Нажмите для редактирования">
          <div class="script-title">${escapeHtml(name)}</div>
          ${status}
        </div>`;
      })
      .join("");
    
    // Добавляем обработчики клика
    scriptsList.querySelectorAll(".script-item").forEach(item => {
      item.addEventListener("click", async () => {
        const ruleId = item.dataset.ruleId;
        if (ruleId) {
          // Сохраняем выбранный ID и открываем страницу опций
          await chrome.storage.session.set({ selectedRuleId: ruleId });
          await chrome.runtime.openOptionsPage();
        }
      });

      item.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        const ruleId = item.dataset.ruleId;
        if (!ruleId) return;
        openScriptMenu(event.clientX, event.clientY, {
          id: ruleId,
          enabled: item.dataset.enabled === "true"
        });
      });
    });
  }

  $("statusLine").textContent = state.enabled ? "Автозапуск активен" : "Автозапуск отключён";
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExactUrlPattern(url) {
  return `^${escapeRegex(url)}$`;
}

async function createRuleForCurrentPage() {
  const tab = await getActiveTab();
  if (!tab?.url) return;
  if (/^(chrome|edge|about):/i.test(tab.url)) {
    showNotification("Нельзя создать правило для этой страницы", "error");
    return;
  }
  const title = (tab.title || "").trim();
  const draft = {
    name: title ? `Скрипт: ${title}` : "Новое правило",
    patternType: "regex",
    pattern: buildExactUrlPattern(tab.url)
  };

  await chrome.storage.session.set({ createRuleDraft: draft });
  await chrome.runtime.openOptionsPage();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function closeScriptMenu() {
  const menu = $("scriptMenu");
  menu.classList.remove("open");
  menu.setAttribute("aria-hidden", "true");
  menu.dataset.ruleId = "";
  menu.dataset.enabled = "";
}

function openScriptMenu(x, y, rule) {
  const menu = $("scriptMenu");
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

async function updateRuleEnabled(ruleId, enabled) {
  const current = await chrome.storage.local.get(null);
  const rules = Array.isArray(current.rules) ? current.rules : [];
  const index = rules.findIndex(rule => rule.id === ruleId);
  if (index === -1) return;
  rules[index] = { ...rules[index], enabled };
  await chrome.storage.local.set({ rules });
}

async function deleteRule(ruleId) {
  const current = await chrome.storage.local.get(null);
  const rules = Array.isArray(current.rules) ? current.rules : [];
  const nextRules = rules.filter(rule => rule.id !== ruleId);
  await chrome.storage.local.set({ rules: nextRules });
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.runtime.sendMessage({ type: "SET_ENABLED", enabled: e.target.checked });
  const statusText = e.target.checked ? "Автозапуск включен" : "Автозапуск отключен";
  showNotification(statusText, "info");
  await refresh();
});

$("runNow").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  $("runNow").textContent = "Запуск...";
  $("runNow").disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: "RUN_NOW", tabId: tab.id, url: tab.url });
    if (!r?.ok) throw new Error(r?.error ?? "Unknown error");
    showNotification("Скрипты выполнены");
  } catch (e) {
    showNotification("Ошибка: " + (e?.message ?? e), "error");
  } finally {
    $("runNow").textContent = "Запустить сейчас";
    $("runNow").disabled = false;
    await refresh();
  }
});

$("openOptions").addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
});

$("createScript").addEventListener("click", async () => {
  await createRuleForCurrentPage();
});

document.addEventListener("click", (event) => {
  const menu = $("scriptMenu");
  if (!menu.classList.contains("open")) return;
  if (menu.contains(event.target)) return;
  closeScriptMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeScriptMenu();
  }
});

window.addEventListener("blur", () => {
  closeScriptMenu();
});

$("menuToggle").addEventListener("click", async () => {
  const menu = $("scriptMenu");
  const ruleId = menu.dataset.ruleId;
  const enabled = menu.dataset.enabled === "true";
  if (!ruleId) return;
  await updateRuleEnabled(ruleId, !enabled);
  const message = enabled ? "Скрипт отключен" : "Скрипт включен";
  showNotification(message, "info");
  closeScriptMenu();
  await refresh();
});

$("menuDelete").addEventListener("click", async () => {
  const menu = $("scriptMenu");
  const ruleId = menu.dataset.ruleId;
  if (!ruleId) return;
  const shouldDelete = window.confirm("Удалить скрипт? Это действие нельзя отменить.");
  if (!shouldDelete) return;
  await deleteRule(ruleId);
  showNotification("Скрипт удален", "info");
  closeScriptMenu();
  await refresh();
});

refresh();
