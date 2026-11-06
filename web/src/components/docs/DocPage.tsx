import { MDXProvider } from "@mdx-js/react";
import type { MDXComponents } from "mdx/types";
import { useEffect, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { docModule, docFrontmatter } from "../../content/docs/loader";
import { DOC_GROUPS, docHref, findDoc, neighbours } from "../../content/docs/nav";
import { TextButton } from "../../ui";
import s from "./docs.module.css";

function currentPath(): string {
  return window.location.hash.replace(/^#/, "").replace(/\/$/, "") || "/docs";
}

function useHashPath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const onHash = () => setPath(currentPath());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return path;
}

function InternalAwareLink({ href = "", children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href.startsWith("/docs/")) return <a href={`#${href}`}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

const components: MDXComponents = {
  a: InternalAwareLink,
  h2: (props) => <h2 className={s.h2} {...props} />,
  h3: (props) => <h3 className={s.h3} {...props} />,
  p: (props) => <p className={s.p} {...props} />,
  ul: (props) => <ul className={s.list} {...props} />,
  ol: (props) => <ol className={s.list} {...props} />,
  li: (props) => <li className={s.item} {...props} />,
  code: (props) => <code className={s.code} {...props} />,
  pre: (props) => <pre className={s.pre} {...props} />,
};

export function DocsRoute() {
  const path = useHashPath();
  const [, , group, slug] = path.split("/");
  if (group && slug && docModule(group, slug)) return <DocArticle group={group} slug={slug} />;
  return <DocsIndex />;
}

export function DocsIndex() {
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>Docs</p>
        <h1>How Seats works</h1>
        <p className={s.lede}>
          Guides, concepts, and evidence for members, buyers, sellers, and clubs. Every page says what it
          doesn't prove.
        </p>
      </header>
      {DOC_GROUPS.map((group) => (
        <section key={group.slug} className={s.group}>
          <h2 className={s.groupTitle}>{group.title}</h2>
          <ul className={s.index}>
            {group.pages.map((page) => (
              <li key={page.slug} className={s.indexItem}>
                <a href={`#${docHref(page)}`}>{page.title}</a>
                <p>{page.summary}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

function DocArticle({ group, slug }: { group: string; slug: string }) {
  const page = findDoc(group, slug);
  const mod = docModule(group, slug);
  if (!page || !mod) return <DocsIndex />;
  const fm = docFrontmatter(group, slug);
  const Content = mod.default;
  const { previous, next } = neighbours(group, slug);
  const groupTitle = DOC_GROUPS.find((g) => g.slug === group)?.title ?? group;
  return (
    <main className={s.page}>
      <header className={s.pageHead}>
        <p className={s.eyebrow}>{groupTitle}</p>
        <h1>{fm.title}</h1>
        <p className={s.lede}>{fm.summary}</p>
      </header>
      <article className={s.article}>
        <MDXProvider components={components}>
          <Content />
        </MDXProvider>
      </article>
      <p className={s.meta}>
        Last verified {fm.lastVerified} against commit <span className="mono">{fm.commit}</span>.
      </p>
      <nav className={s.pager} aria-label="Doc pages">
        <PagerLink label="Previous" page={previous} />
        <PagerLink label="Next" page={next} />
      </nav>
    </main>
  );
}

function PagerLink({ label, page }: { label: string; page: { group: string; slug: string; title: string } | undefined }): ReactNode {
  if (!page) return <span />;
  return (
    <TextButton href={`#${docHref(page)}`}>
      {label}: {page.title}
    </TextButton>
  );
}
