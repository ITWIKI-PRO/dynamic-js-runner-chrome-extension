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
  const matched = url ? rules.filter(r => (r?.enabled !== false) && urlMatchesRule(r, url)) : [];
  
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
        return `<div class="script-item" data-rule-id="${rule.id}" title="Нажмите для редактирования">${escapeHtml(name)}</div>`;
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
    });
  }

  $("statusLine").textContent = state.enabled ? "Автозапуск активен" : "Автозапуск отключён";
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

refresh();
