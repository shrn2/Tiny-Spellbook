const SKILLSMP_SEARCH_URL = "https://skillsmp.com/api/v1/skills/search";
const STORAGE_KEY = "skillsmpInstalledSkills";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      console.error("Skill Launcher background error", error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });

  return true;
});

async function handleMessage(message = {}) {
  switch (message.type) {
    case "skillsmp:search":
      return searchSkills(message.query);
    case "skillsmp:install":
      return installSkill(message.skill);
    case "skillsmp:list-installed":
      return listInstalledSkills();
    case "skillsmp:get-markdown":
      return getInstalledMarkdown(message.id);
    case "skillsmp:remove":
      return removeInstalledSkill(message.id);
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function searchSkills(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const url = new URL(SKILLSMP_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", "8");
  url.searchParams.set("sortBy", "stars");

  const response = await fetch(url.toString());
  if (!response.ok) throw new Error(`SkillsMP search failed: ${response.status}`);

  const json = await response.json();
  if (!json.success) throw new Error(json.error?.message || "SkillsMP search failed");

  return (json.data?.skills || []).map((skill) => ({
    id: skill.id,
    name: skill.name,
    author: skill.author,
    description: skill.description,
    githubUrl: skill.githubUrl,
    skillUrl: skill.skillUrl,
    stars: skill.stars,
    updatedAt: skill.updatedAt
  }));
}

async function installSkill(skill) {
  if (!skill?.id || !skill?.githubUrl) throw new Error("Skill is missing GitHub source URL");

  const markdown = await fetchSkillMarkdown(skill.githubUrl);
  const metadata = metadataFromMarkdown(markdown, skill);
  const installed = await readInstalledSkills();
  const id = safeId(skill.id);
  const savedSkill = {
    id,
    storageId: id,
    name: metadata.name,
    description: metadata.description,
    file: null,
    source: "skillsmp",
    author: skill.author || "",
    githubUrl: skill.githubUrl,
    skillUrl: skill.skillUrl,
    stars: skill.stars || 0,
    installedAt: new Date().toISOString(),
    markdown
  };

  const next = [savedSkill, ...installed.filter((item) => item.id !== id)];
  await chrome.storage.local.set({ [STORAGE_KEY]: next });

  const { markdown: _markdown, ...withoutMarkdown } = savedSkill;
  return withoutMarkdown;
}

async function listInstalledSkills() {
  const installed = await readInstalledSkills();
  return installed.map(({ markdown: _markdown, ...skill }) => skill);
}

async function getInstalledMarkdown(id) {
  const installed = await readInstalledSkills();
  const skill = installed.find((item) => item.id === id || item.storageId === id);
  if (!skill) throw new Error("Installed skill not found");
  return skill.markdown;
}

async function removeInstalledSkill(id) {
  const installed = await readInstalledSkills();
  const next = installed.filter((item) => item.id !== id && item.storageId !== id);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return { removed: installed.length - next.length };
}

async function readInstalledSkills() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY]) ? result[STORAGE_KEY] : [];
}

async function fetchSkillMarkdown(githubUrl) {
  const parsed = parseGitHubUrl(githubUrl);
  if (!parsed) throw new Error("Only GitHub-backed SkillsMP skills can be loaded right now");

  if (parsed.kind === "blob") {
    return fetchText(rawUrl(parsed.owner, parsed.repo, parsed.ref, parsed.path));
  }

  const directCandidates = ["SKILL.md", "skill.md", "README.md", "readme.md"]
    .map((file) => rawUrl(parsed.owner, parsed.repo, parsed.ref, joinPath(parsed.path, file)));

  for (const candidate of directCandidates) {
    const markdown = await tryFetchText(candidate);
    if (markdown) return markdown;
  }

  const apiUrl = new URL(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${parsed.path}`);
  apiUrl.searchParams.set("ref", parsed.ref);

  const response = await fetch(apiUrl.toString(), {
    headers: { Accept: "application/vnd.github+json" }
  });
  if (!response.ok) throw new Error(`Could not inspect GitHub skill folder: ${response.status}`);

  const contents = await response.json();
  const files = Array.isArray(contents) ? contents : [contents];
  const markdownFile = files.find((file) => /^skill\.md$/i.test(file.name))
    || files.find((file) => file.name?.toLowerCase().endsWith(".md"));

  if (!markdownFile?.download_url) throw new Error("No markdown file found in GitHub skill folder");
  return fetchText(markdownFile.download_url);
}

function parseGitHubUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const [owner, repo, kind, ref, ...rest] = parts;
  if (!owner || !repo || !kind || !ref || !rest.length) return null;
  if (kind !== "tree" && kind !== "blob") return null;

  return { owner, repo, kind, ref, path: rest.join("/") };
}

function rawUrl(owner, repo, ref, path) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;
}

function joinPath(base, file) {
  return [base, file].filter(Boolean).join("/");
}

async function tryFetchText(url) {
  const response = await fetch(url);
  if (!response.ok) return null;
  return response.text();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not download skill markdown: ${response.status}`);
  return response.text();
}

function metadataFromMarkdown(markdown, fallback) {
  const frontMatter = parseFrontMatter(markdown);
  return {
    name: frontMatter.name || fallback.name || "Untitled skill",
    description: frontMatter.description || fallback.description || firstParagraph(markdown)
  };
}

function parseFrontMatter(markdown) {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!match) return {};

  const lines = match[1].split(/\r?\n/);
  const data = {};

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;

    const [, key, rawValue] = pair;
    if (rawValue === ">" || rawValue === "|") {
      const parts = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        index += 1;
        parts.push(lines[index].trim());
      }
      data[key] = parts.join(rawValue === ">" ? " " : "\n").trim();
      continue;
    }

    data[key] = rawValue.replace(/^['\"]|['\"]$/g, "").trim();
  }

  return data;
}

function firstParagraph(markdown) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/, "")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/[#*_`>\-]/g, "").trim())
    .find(Boolean) || "";
}

function safeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
