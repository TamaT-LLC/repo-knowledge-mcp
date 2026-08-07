import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const documentationRoot = join(repositoryRoot, "docs");
const markdownFiles = (await collectMarkdownFiles(documentationRoot)).sort();
const failures = [];

for (const markdownPath of markdownFiles) {
  const source = await readFile(markdownPath, "utf8");
  const visibleLines = linesOutsideFences(source);
  checkHeadingStructure(markdownPath, visibleLines);
  checkExplicitAnchors(markdownPath, visibleLines);
  await checkLinks(
    markdownPath,
    visibleLines.map(({ line }) => line).join("\n"),
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(
    `Verified Markdown structure and links in ${markdownFiles.length} files.`,
  );
}

function linesOutsideFences(source) {
  const result = [];
  let fence = null;
  for (const [index, line] of source.split("\n").entries()) {
    const marker = /^\s*(```|~~~)/u.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null) result.push({ line, lineNumber: index + 1 });
  }
  return result;
}

async function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function checkHeadingStructure(markdownPath, lines) {
  let h1Count = 0;
  let previousLevel = 0;
  for (const { line, lineNumber } of lines) {
    const match = /^(#{1,6})\s+\S/u.exec(line);
    if (!match) continue;
    const level = match[1].length;
    if (level === 1) h1Count += 1;
    if (previousLevel > 0 && level > previousLevel + 1) {
      fail(
        markdownPath,
        lineNumber,
        `heading level jumps from H${previousLevel} to H${level}`,
      );
    }
    previousLevel = level;
  }
  if (h1Count !== 1) {
    fail(markdownPath, 1, `expected exactly one H1, found ${h1Count}`);
  }
}

function checkExplicitAnchors(markdownPath, lines) {
  const anchors = new Map();
  for (const { line, lineNumber } of lines) {
    for (const match of line.matchAll(/<a\s+id="([^"]+)"\s*><\/a>/gu)) {
      const id = match[1];
      const previous = anchors.get(id);
      if (previous !== undefined) {
        fail(
          markdownPath,
          lineNumber,
          `duplicate explicit anchor #${id}; first used at line ${previous}`,
        );
      } else {
        anchors.set(id, lineNumber);
      }
    }
  }
}

async function checkLinks(markdownPath, visibleSource) {
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
  for (const match of visibleSource.matchAll(linkPattern)) {
    const href = match[1];
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href)) continue;
    const [rawPath, rawFragment] = href.split("#", 2);
    let targetPath;
    try {
      targetPath = rawPath
        ? resolve(dirname(markdownPath), decodeURIComponent(rawPath))
        : markdownPath;
    } catch {
      fail(
        markdownPath,
        lineForOffset(visibleSource, match.index),
        `invalid link encoding: ${href}`,
      );
      continue;
    }
    if (relative(repositoryRoot, targetPath).startsWith("..")) {
      fail(
        markdownPath,
        lineForOffset(visibleSource, match.index),
        `link escapes repository: ${href}`,
      );
      continue;
    }
    let metadata;
    try {
      metadata = await stat(targetPath);
    } catch {
      fail(
        markdownPath,
        lineForOffset(visibleSource, match.index),
        `missing link target: ${href}`,
      );
      continue;
    }
    if (!metadata.isFile()) {
      fail(
        markdownPath,
        lineForOffset(visibleSource, match.index),
        `link target is not a file: ${href}`,
      );
      continue;
    }
    if (rawFragment) {
      const fragment = decodeURIComponent(rawFragment);
      const target = await readFile(targetPath, "utf8");
      if (!target.includes(`<a id="${fragment}"></a>`)) {
        fail(
          markdownPath,
          lineForOffset(visibleSource, match.index),
          `missing explicit anchor in ${href}`,
        );
      }
    }
  }
}

function lineForOffset(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function fail(path, line, message) {
  failures.push(`${relative(repositoryRoot, path)}:${line}: ${message}`);
}
