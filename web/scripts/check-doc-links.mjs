import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const docsRoot = path.resolve("src/content/docs");
const navSource = await readFile(path.join(docsRoot, "nav.ts"), "utf8");

const listed = new Set(
  [...navSource.matchAll(/\["([a-z-]+)", "[^"]+", \[([^\]]*)\]\]/g)].flatMap(([, group, pages]) =>
    [...pages.matchAll(/"([a-z-]+)"/g)].map(([, slug]) => `${group}/${slug}`),
  ),
);

const groups = (await readdir(docsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
const files = (await Promise.all(
  groups.map(async (group) =>
    (await readdir(path.join(docsRoot, group.name), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
      .map((entry) => `${group.name}/${entry.name.replace(/\.mdx$/, "")}`),
  ),
)).flat();

let failures = 0;
const fail = (message) => {
  console.error(message);
  failures++;
};

for (const page of listed) if (!files.includes(page)) fail(`nav lists ${page} but no MDX file exists`);
for (const page of files) if (!listed.has(page)) fail(`${page}.mdx exists but nav.ts doesn't list it`);

const requiredKeys = ["title", "summary", "lastVerified", "commit"];
const externalLinks = new Set();
for (const page of files) {
  const raw = await readFile(path.join(docsRoot, `${page}.mdx`), "utf8");
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  for (const key of requiredKeys) {
    if (!new RegExp(`^${key}:\\s*\\S`, "m").test(block)) fail(`${page}.mdx is missing frontmatter key ${key}`);
  }
  for (const [, target] of raw.matchAll(/\]\((\/docs\/[^)\s]+)\)/g)) {
    if (!files.includes(target.replace(/^\/docs\//, ""))) fail(`${page}.mdx links to missing page ${target}`);
  }
  for (const match of raw.matchAll(/https:\/\/[^\s)<>"'`]+/g)) externalLinks.add(match[0].replace(/[.,!?]+$/, ""));
}

let checked = 0;
for (const url of externalLinks) {
  checked++;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "follow" });
    console.log(`${response.status} ${url}`);
    if (!response.ok) fail(`${url} returned ${response.status}`);
  } catch (error) {
    fail(`${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`Checked ${files.length} pages and ${checked} external links, ${failures} problems.`);
if (failures) process.exitCode = 1;
