#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const skillsDir = path.join(root, "skills");
const outputPath = path.join(root, "skill-index.json");

function firstParagraph(markdown) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/, "")
    .split(/\n\s*\n/)
    .map((part) => part.replace(/[#*_`>\-]/g, "").trim())
    .find(Boolean) || "";
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

function toTitle(id) {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

if (!fs.existsSync(skillsDir)) {
  fs.mkdirSync(skillsDir, { recursive: true });
}

const skills = fs.readdirSync(skillsDir)
  .filter((file) => file.toLowerCase().endsWith(".md"))
  .sort((a, b) => a.localeCompare(b))
  .map((file) => {
    const fullPath = path.join(skillsDir, file);
    const markdown = fs.readFileSync(fullPath, "utf8");
    const frontMatter = parseFrontMatter(markdown);
    const id = path.basename(file, ".md");

    return {
      id,
      name: frontMatter.name || toTitle(id),
      description: frontMatter.description || firstParagraph(markdown),
      file: `skills/${file}`
    };
  });

fs.writeFileSync(outputPath, `${JSON.stringify(skills, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, outputPath)} with ${skills.length} skill(s).`);
