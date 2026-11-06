import { docFrontmatter } from "./loader";

export type DocPage = { group: string; slug: string; title: string; summary: string };
export type DocGroup = { slug: string; title: string; pages: DocPage[] };

const LAYOUT: [string, string, string[]][] = [
  ["get-started", "Get started", ["introduction", "how-it-works", "quickstart"]],
  ["guides", "Guides", ["join-a-club", "buy-a-seat", "sell-your-seat", "write-your-brief", "review-a-vote", "open-the-vault"]],
  ["concepts", "Concepts", ["overview", "the-seat", "the-delegate", "what-happens-at-the-deadline", "how-the-money-moves"]],
  ["reference", "Reference", ["states", "fees-and-split", "deployment", "limitations"]],
  ["security", "Security", ["trust-model", "permissions", "data-and-privacy", "failure-and-recovery"]],
  ["evidence", "Evidence", ["live-deployment", "verified-examples"]],
  ["help", "Help", ["troubleshooting", "faq"]],
];

export const DOC_GROUPS: DocGroup[] = LAYOUT.map(([slug, title, pages]) => ({
  slug,
  title,
  pages: pages.map((page) => {
    const fm = docFrontmatter(slug, page);
    return { group: slug, slug: page, title: fm.title, summary: fm.summary };
  }),
}));

export const ALL_DOCS = DOC_GROUPS.flatMap((row) => row.pages);

export function findDoc(group: string, slug: string): DocPage | undefined {
  return ALL_DOCS.find((page) => page.group === group && page.slug === slug);
}

export function docHref(page: Pick<DocPage, "group" | "slug">): string {
  return `/docs/${page.group}/${page.slug}`;
}

export function neighbours(group: string, slug: string) {
  const index = ALL_DOCS.findIndex((page) => page.group === group && page.slug === slug);
  return {
    previous: index > 0 ? ALL_DOCS[index - 1] : undefined,
    next: index >= 0 && index < ALL_DOCS.length - 1 ? ALL_DOCS[index + 1] : undefined,
  };
}
