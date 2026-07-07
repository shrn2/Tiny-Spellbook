(() => {
  const ROOT_ID = "skill-launcher-root";
  const INDEX_URL = chrome.runtime.getURL("skill-index.json");

  let wasNewChat = null;
  let currentNewChatKey = 0;
  let loadingKey = null;
  let cachedSkills = null;
  let visibleSkills = [];
  const selectedSkillKeys = new Set();
  const hiddenNewChatKeys = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function sendMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || "Extension background request failed"));
          return;
        }
        resolve(response.result);
      });
    });
  }

  function isChatGptPage() {
    return /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname);
  }

  function isLikelyNewChat() {
    const path = location.pathname.replace(/\/+$/, "");
    return path === "" || path === "/" || path === "/new" || path.startsWith("/g/");
  }

  function skillKey(skill) {
    return skill.storageId || (skill.isInstalled ? skill.id : skill.file || skill.id);
  }

  async function loadSkills({ refresh = false } = {}) {
    if (cachedSkills && !refresh) return cachedSkills;

    const response = await fetch(INDEX_URL);
    if (!response.ok) throw new Error(`Could not load skill index: ${response.status}`);
    const localSkills = await response.json();
    const installedSkills = await sendMessage("skillsmp:list-installed").catch(() => []);

    cachedSkills = [
      ...(Array.isArray(localSkills) ? localSkills : localSkills.skills || []),
      ...installedSkills.map((skill) => ({ ...skill, isInstalled: true }))
    ];
    return cachedSkills;
  }

  async function loadSkillMarkdown(skill) {
    if (skill.storageId || skill.isInstalled) {
      return sendMessage("skillsmp:get-markdown", { id: skill.storageId || skill.id });
    }

    const file = skill.file || `skills/${skill.id}.md`;
    const response = await fetch(chrome.runtime.getURL(file));
    if (!response.ok) throw new Error(`Could not load ${file}: ${response.status}`);
    return response.text();
  }

  function composerCandidates() {
    return [
      document.querySelector("textarea#prompt-textarea"),
      document.querySelector("#prompt-textarea[contenteditable='true']"),
      document.querySelector("[contenteditable='true'][data-id='root']"),
      document.querySelector("main form textarea"),
      document.querySelector("main form [contenteditable='true']"),
      document.querySelector("textarea"),
      document.querySelector("[contenteditable='true']")
    ].filter(Boolean);
  }

  async function waitForComposer(timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = composerCandidates()[0];
      if (composer) return composer;
      await sleep(150);
    }
    throw new Error("ChatGPT composer not found");
  }

  function setNativeTextareaValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function fillComposer(composer, text) {
    composer.focus();

    if (composer.tagName === "TEXTAREA") {
      setNativeTextareaValue(composer, text);
      return;
    }

    document.execCommand("selectAll", false);
    const inserted = document.execCommand("insertText", false, text);

    if (!inserted) {
      composer.textContent = text;
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text
      }));
    }
  }

  function findSendButton() {
    const selectors = [
      "button[data-testid='send-button']",
      "button[aria-label='Send prompt']",
      "button[aria-label='Send message']",
      "button[aria-label*='Send']",
      "main form button[type='submit']"
    ];

    for (const selector of selectors) {
      const button = document.querySelector(selector);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
    }

    return null;
  }

  async function submitComposer(timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const button = findSendButton();
      if (button) {
        button.click();
        return;
      }
      await sleep(100);
    }

    const composer = composerCandidates()[0];
    composer?.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    }));
  }

  function removeOverlay() {
    document.getElementById(ROOT_ID)?.remove();
  }

  function hideForCurrentNewChat() {
    if (currentNewChatKey) hiddenNewChatKeys.add(currentNewChatKey);
    selectedSkillKeys.clear();
    removeOverlay();
  }

  function setStatus(message, kind = "") {
    const status = document.querySelector(`#${ROOT_ID} [data-skill-status]`);
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
  }

  function combinedPrompt(parts) {
    if (parts.length === 1) return parts[0].markdown.trim();

    const skillBlocks = parts.map((part, index) => [
      `## Skill ${index + 1}: ${part.name}`,
      "",
      part.markdown.trim()
    ].join("\n"));

    return [
      "Use all of these skills together for this chat. If any instructions conflict, prefer the later skill in this message.",
      "",
      skillBlocks.join("\n\n---\n\n")
    ].join("\n");
  }

  async function runSkills(skills) {
    if (!skills.length) return;

    try {
      setStatus(skills.length === 1 ? `Loading ${skills[0].name}…` : `Loading ${skills.length} skills…`);
      const parts = [];

      for (const skill of skills) {
        parts.push({
          name: skill.name || skill.id,
          markdown: await loadSkillMarkdown(skill)
        });
      }

      setStatus("Pasting into ChatGPT…");
      const composer = await waitForComposer();
      fillComposer(composer, combinedPrompt(parts));
      setStatus("Launching first reply…");
      await submitComposer();
      hideForCurrentNewChat();
    } catch (error) {
      console.error("Skill Launcher failed", error);
      setStatus(error.message || "Could not launch skills", "error");
    }
  }

  function selectedSkills() {
    return visibleSkills.filter((skill) => selectedSkillKeys.has(skillKey(skill)));
  }

  function updateSelectionUi() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    const count = selectedSkillKeys.size;
    root.querySelectorAll(".skill-launcher-card").forEach((card) => {
      const isSelected = selectedSkillKeys.has(card.dataset.skillKey);
      card.classList.toggle("is-selected", isSelected);
      card.setAttribute("aria-pressed", String(isSelected));
      const mark = card.querySelector(".skill-launcher-check");
      if (mark) mark.textContent = isSelected ? "✓" : "+";
    });

    const launch = root.querySelector(".skill-launcher-launch");
    const countNode = root.querySelector(".skill-launcher-selected-count");
    if (launch) {
      launch.disabled = count === 0;
      launch.classList.toggle("has-selection", count > 0);
      launch.title = count > 0 ? `Launch ${count} selected skill${count === 1 ? "" : "s"}` : "Select skills to launch";
      launch.setAttribute("aria-label", launch.title);
      const badge = launch.querySelector(".skill-launcher-launch-count");
      if (badge) badge.textContent = String(count);
    }
    if (countNode) {
      countNode.textContent = count === 0 ? "Choose one or many." : `${count} selected.`;
    }
  }

  async function removeInstalledSkill(skill) {
    const key = skillKey(skill);
    try {
      await sendMessage("skillsmp:remove", { id: key });
      selectedSkillKeys.delete(key);
      cachedSkills = null;
      const skills = await loadSkills({ refresh: true });
      setStatus(`Removed ${skill.name || skill.id}.`);
      renderSkillList(skills);
    } catch (error) {
      console.error("Skill remove failed", error);
      setStatus(error.message || "Could not remove skill", "error");
    }
  }

  function skillButton(skill) {
    const key = skillKey(skill);
    const card = document.createElement("div");
    card.className = "skill-launcher-card";
    card.dataset.skillKey = key;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-pressed", "false");
    card.innerHTML = `
      <span class="skill-launcher-check">+</span>
      <span class="skill-launcher-card-title">${escapeHtml(skill.name || skill.id)}</span>
      ${skill.isInstalled ? `<button class="skill-launcher-remove" type="button" aria-label="Remove ${escapeHtml(skill.name || skill.id)}" title="Remove skill">×</button>` : ""}
    `;

    const toggle = () => {
      if (selectedSkillKeys.has(key)) selectedSkillKeys.delete(key);
      else selectedSkillKeys.add(key);
      updateSelectionUi();
    };

    card.addEventListener("click", toggle);
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggle();
    });

    card.querySelector(".skill-launcher-remove")?.addEventListener("click", (event) => {
      event.stopPropagation();
      removeInstalledSkill(skill);
    });

    return card;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function body(root = document.getElementById(ROOT_ID)) {
    return root?.querySelector(".skill-launcher-body");
  }

  function renderSkillList(skills, root = document.getElementById(ROOT_ID)) {
    const container = body(root);
    if (!container) return;

    visibleSkills = skills;
    for (const selected of [...selectedSkillKeys]) {
      if (!visibleSkills.some((skill) => skillKey(skill) === selected)) selectedSkillKeys.delete(selected);
    }

    root.classList.remove("is-loading-skills");
    container.innerHTML = `<div class="skill-launcher-list"></div>`;
    const list = container.querySelector(".skill-launcher-list");

    if (skills.length === 0) {
      list.innerHTML = `<div class="skill-launcher-empty">No skills found in <code>skills/</code>.</div>`;
    } else {
      skills.forEach((skill) => list.appendChild(skillButton(skill)));
    }

    updateSelectionUi();
  }

  function renderSearch(root = document.getElementById(ROOT_ID)) {
    const container = body(root);
    if (!container) return;

    root.classList.add("is-loading-skills");
    container.innerHTML = `
      <div class="skill-launcher-search">
        <div class="skill-launcher-search-head">
          <button class="skill-launcher-back" type="button" aria-label="Back to skills">←</button>
          <span>Load from SkillsMP</span>
        </div>
        <form class="skill-launcher-search-form">
          <input class="skill-launcher-search-input" type="search" placeholder="Search SkillsMP…" aria-label="Search SkillsMP skills" />
          <button class="skill-launcher-search-button" type="submit">Search</button>
        </form>
        <div class="skill-launcher-results">
          <div class="skill-launcher-empty">Find a spell from SkillsMP. Loaded skills stay here for later.</div>
        </div>
      </div>
    `;

    const input = container.querySelector(".skill-launcher-search-input");
    const form = container.querySelector(".skill-launcher-search-form");
    const results = container.querySelector(".skill-launcher-results");
    container.querySelector(".skill-launcher-back").addEventListener("click", () => renderSkillList(visibleSkills));
    input.focus();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) return;

      results.innerHTML = `<div class="skill-launcher-empty">Searching SkillsMP…</div>`;
      setStatus("");

      try {
        const found = await sendMessage("skillsmp:search", { query });
        renderSearchResults(found, results);
      } catch (error) {
        console.error("SkillsMP search failed", error);
        results.innerHTML = `<div class="skill-launcher-empty skill-launcher-error">${escapeHtml(error.message || "Search failed")}</div>`;
      }
    });
  }

  function renderSearchResults(skills, results) {
    results.innerHTML = "";

    if (!skills.length) {
      results.innerHTML = `<div class="skill-launcher-empty">No SkillsMP matches. Try another word.</div>`;
      return;
    }

    skills.forEach((skill) => {
      const item = document.createElement("article");
      item.className = "skill-launcher-result";
      item.innerHTML = `
        <div class="skill-launcher-result-main">
          <strong>${escapeHtml(skill.name || "Untitled skill")}</strong>
          <span>${escapeHtml(skill.author ? `by ${skill.author}` : "SkillsMP")}${skill.stars ? ` · ★ ${Number(skill.stars).toLocaleString()}` : ""}</span>
        </div>
        <div class="skill-launcher-result-actions">
          <button type="button" class="skill-launcher-install">Load</button>
          ${skill.skillUrl ? `<a href="${escapeHtml(skill.skillUrl)}" target="_blank" rel="noreferrer">Open</a>` : ""}
        </div>
      `;

      item.querySelector(".skill-launcher-install").addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "Loading…";

        try {
          const installed = await sendMessage("skillsmp:install", { skill });
          cachedSkills = null;
          const skills = await loadSkills({ refresh: true });
          selectedSkillKeys.add(installed.storageId || installed.id);
          setStatus(`Loaded ${installed.name}. Selected it for launch.`);
          renderSkillList(skills);
        } catch (error) {
          console.error("SkillsMP install failed", error);
          button.disabled = false;
          button.textContent = "Load";
          setStatus(error.message || "Could not load skill", "error");
        }
      });

      results.appendChild(item);
    });
  }

  function render(skills) {
    removeOverlay();

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <section class="skill-launcher-panel" role="region" aria-labelledby="skill-launcher-title">
        <div class="skill-launcher-topbar">
          <div class="skill-launcher-kicker">tiny spellbook</div>
          <div class="skill-launcher-actions">
            <button class="skill-launcher-launch" type="button" disabled title="Select skills to launch" aria-label="Select skills to launch">
              <span class="skill-launcher-launch-symbol">↗</span>
              <span class="skill-launcher-launch-count">0</span>
            </button>
            <button class="skill-launcher-load" type="button" aria-label="Load skill from SkillsMP" title="Load from SkillsMP">↓</button>
            <button class="skill-launcher-close" type="button" aria-label="Close">×</button>
          </div>
        </div>
        <h1 id="skill-launcher-title">Start with skills?</h1>
        <p class="skill-launcher-subtitle"><span class="skill-launcher-selected-count">Choose one or many.</span> I’ll paste, send, then poof.</p>
        <div class="skill-launcher-body"></div>
        <p class="skill-launcher-status" data-skill-status></p>
      </section>
    `;

    selectedSkillKeys.clear();
    root.querySelector(".skill-launcher-close").addEventListener("click", hideForCurrentNewChat);
    root.querySelector(".skill-launcher-load").addEventListener("click", () => renderSearch(root));
    root.querySelector(".skill-launcher-launch").addEventListener("click", () => runSkills(selectedSkills()));
    document.documentElement.appendChild(root);
    renderSkillList(skills, root);
  }

  async function maybeShowWidget() {
    if (!isChatGptPage()) return;

    const nowNewChat = isLikelyNewChat();
    if (!nowNewChat) {
      removeOverlay();
      wasNewChat = false;
      loadingKey = null;
      return;
    }

    if (wasNewChat !== true) currentNewChatKey += 1;
    wasNewChat = true;

    const key = currentNewChatKey;
    if (document.getElementById(ROOT_ID) || hiddenNewChatKeys.has(key) || loadingKey === key) return;

    loadingKey = key;
    try {
      const skills = await loadSkills();
      if (key !== currentNewChatKey || !isLikelyNewChat() || hiddenNewChatKeys.has(key)) return;
      render(skills);
    } catch (error) {
      console.error("Skill Launcher failed to load", error);
    } finally {
      if (loadingKey === key) loadingKey = null;
    }
  }

  function installRouteWatcher() {
    const notify = () => window.dispatchEvent(new Event("skill-launcher-route-change"));

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        notify();
        return result;
      };
    }

    window.addEventListener("popstate", notify);
    window.addEventListener("hashchange", notify);
    window.addEventListener("skill-launcher-route-change", () => setTimeout(maybeShowWidget, 80));

    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      maybeShowWidget();
    }, 500);
  }

  installRouteWatcher();
  maybeShowWidget();
})();
