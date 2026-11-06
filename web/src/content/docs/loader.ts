import type { ComponentType } from "react";

export type DocFrontmatter = {
  title: string;
  summary: string;
  lastVerified: string;
  commit: string;
};

export type DocModule = {
  default: ComponentType;
  frontmatter: DocFrontmatter;
};

const pages = import.meta.glob<DocModule>("./*/*.mdx", { eager: true });

export function docModule(group: string, slug: string): DocModule | undefined {
  return pages[`./${group}/${slug}.mdx`];
}

export function docFrontmatter(group: string, slug: string): DocFrontmatter {
  const fm = docModule(group, slug)?.frontmatter;
  if (!fm?.title || !fm.summary || !fm.lastVerified || !fm.commit) {
    throw new Error(`Doc page has missing frontmatter: ${group}/${slug}`);
  }
  return fm;
}
