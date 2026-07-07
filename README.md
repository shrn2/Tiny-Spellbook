# ChatGPT Skill Launcher

Tiny Arc/Chromium extension: when you open ChatGPT, a minimalist skill picker appears. Select one or more markdown skills, and the extension pastes them into the ChatGPT composer, sends the prompt, then disappears.

## Use in Arc

1. Open `arc://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `extension_gpt_skills`.
5. Open `https://chatgpt.com/`.

## SkillsMP loader

Click the `↯` icon in the widget to search [SkillsMP](https://skillsmp.com/). Press **Load** on a result to download its markdown from the skill's GitHub source and save it for later chats. Loaded skills can be selected together with local skills.

Browser extensions cannot silently write into this unpacked extension's local `skills/` folder. Loaded SkillsMP skills are stored in `chrome.storage.local` instead, so they persist across browser sessions and show up next to local skills.

## Add local skills

1. Add another markdown file to `skills/`, e.g. `skills/teacher.md`.
2. Optionally include front matter:

   ```md
   ---
   name: teacher
   description: Explain things patiently with examples.
   ---
   ```

3. Rebuild the index:

   ```bash
   npm run build
   ```

4. Reload the unpacked extension in `arc://extensions`.

The extension reads `skill-index.json`, which is generated from the markdown files in `skills/`.
