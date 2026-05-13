import type { Page } from "playwright";

export interface OutlineElement {
  idx: number;
  role: string;
  name: string;
  tag: string;
  text: string;
  href: string | null;
  visible: boolean;
}

const OUTLINE_SCRIPT = `() => {
  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.href) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    // <summary> is the clickable affordance for a <details> disclosure widget.
    // Treat it like a button — the persona judge needs to see "How to find
    // your library ID" listed as an interactive thing on the page, otherwise
    // collapsed help is invisible and abandonment looks unavoidable.
    if (tag === 'summary') return 'button';
    return tag;
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const ids = labelledby.split(/\\s+/).filter(Boolean);
      const parts = ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? '').filter(Boolean);
      if (parts.length > 0) return parts.join(' ');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const id = el.id;
      if (id) {
        const lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lab && lab.textContent) return lab.textContent.trim();
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
    }
    if (el.tagName === 'IMG') return (el.getAttribute('alt') || '').trim();
    const txt = (el.innerText || el.textContent || '').trim();
    return txt.slice(0, 200);
  };
  const selectors = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="checkbox"]',
    '[role="radio"]', '[role="textbox"]', '[role="combobox"]', '[role="menuitem"]',
    'nav', 'main', 'header', 'footer',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // <summary> is the clickable affordance for native <details> disclosure
    // widgets. Without this, collapsed help/instructions are invisible to
    // both the actor (can't click to expand) and the judge (can't tell
    // whether a hint exists).
    'summary',
    '[tabindex]:not([tabindex="-1"])',
  ];
  const seen = new Set();
  const out = [];
  const all = document.querySelectorAll(selectors.join(','));
  let idx = 0;
  for (const el of all) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (!isVisible(el)) continue;
    const name = nameOf(el);
    if (!name && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') continue;
    out.push({
      idx: idx++,
      role: roleOf(el),
      name,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().slice(0, 120),
      href: el.tagName === 'A' ? (el.getAttribute('href') || null) : null,
      visible: true,
    });
    if (out.length >= 200) break;
  }
  return out;
}`;

export async function getOutline(page: Page): Promise<OutlineElement[]> {
  return (await page.evaluate(`(${OUTLINE_SCRIPT})()`)) as OutlineElement[];
}

export function summarizeOutline(elements: OutlineElement[], max = 80): string {
  const slice = elements.slice(0, max);
  return slice
    .map(
      (e) =>
        `[${e.idx}] ${e.role}${e.name ? ` "${e.name.replace(/\s+/g, " ").slice(0, 80)}"` : ""}${e.href ? ` href=${e.href.slice(0, 60)}` : ""}`,
    )
    .join("\n");
}

/**
 * Return a compact representation of visible page text the role-based outline
 * cannot capture: stat cards (`<div class="stat-value">12</div><div
 * class="stat-label">Failed</div>`), status banners, descriptive paragraphs,
 * empty-state messages, etc. The outline lists only role-bearing interactive
 * elements + headings, so a dashboard whose KPI numbers live in unsemantic
 * divs is effectively invisible to the judge unless we also surface text.
 *
 * Compression is whitespace-collapse + length cap. We deliberately do not
 * filter further — the judge is the one deciding what's relevant.
 */
export async function getPageText(page: Page, max = 4000): Promise<string> {
  const raw = (await page
    .evaluate(`document.body ? document.body.innerText : ""`)
    .catch(() => "")) as string;
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}
