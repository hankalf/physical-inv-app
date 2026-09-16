/*
 * The small slice of Markdown the manual is written in, turned into HTML.
 *
 * Deliberately not a general Markdown engine: the app ships with no runtime
 * dependencies and a printed manual is not a reason to take one on. It handles
 * what docs/SOP.md actually uses - headings, paragraphs, both kinds of list,
 * tables, block quotes, fenced code, figures, rules and the odd raw <img>.
 */

const esc = (s) => s.replace(/&(?!(?:[a-zA-Z]+|#\d+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// a placeholder no manual will contain, so inline code survives escaping untouched
const CODE_OPEN = '{{code:';
const CODE_SHUT = '}}';

/** Inline markup, in an order where one rule cannot eat another's markers. */
export function inline(text) {
  const code = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => CODE_OPEN + (code.push(c) - 1) + CODE_SHUT);
  s = esc(s);
  s = s.replace(/&lt;br\s*\/?&gt;/g, '<br>');
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(—-])\*([^*\n]+)\*(?=$|[\s.,;:)—-])/g, '$1<em>$2</em>');
  return s.replace(/\{\{code:(\d+)\}\}/g, (_, i) => `<code>${esc(code[Number(i)])}</code>`);
}

const slug = (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

const cells = (row) => row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdownToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const para = [];
  const flush = () => {
    if (!para.length) return;
    const text = para.join(' ');
    para.length = 0;
    // a line that is nothing but italics is a figure caption, not a paragraph
    const caption = /^\*[^*].*\*$/.test(text);
    out.push(`<p${caption ? ' class="caption"' : ''}>${inline(text)}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { flush(); i++; continue; }

    if (line.startsWith('```')) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) body.push(lines[i]);
      i++;
      out.push(`<pre class="code"><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length} id="${slug(h[2])}">${inline(h[2])}</h${h[1].length}>`);
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) { flush(); out.push('<hr>'); i++; continue; }

    const fig = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (fig) {
      flush();
      out.push(`<figure><img src="${fig[2]}" alt="${fig[1]}"></figure>`);
      i++;
      continue;
    }

    if (line.startsWith('<')) {   // the manual's one hand-sized screenshot
      flush();
      out.push(`<figure>${line}</figure>`);
      i++;
      continue;
    }

    if (line.startsWith('>')) {
      flush();
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) { body.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote>${markdownToHtml(body.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      flush();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].startsWith('|')) { body.push(cells(lines[i])); i++; }
      // a table with no header is the manual's way of laying screenshots side by side
      const blank = head.every((c) => !c);
      const th = blank ? '' : `<thead><tr>${head.map((c, n) => `<th style="text-align:${align[n]}">${inline(c)}</th>`).join('')}</tr></thead>`;
      const tr = body.map((r) => `<tr>${r.map((c, n) => `<td style="text-align:${align[n]}">${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table class="${blank ? 'figures' : 'data'}">${th}<tbody>${tr}</tbody></table>`);
      continue;
    }

    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m && m[1].length <= 1) { items.push([m[3]]); i++; continue; }
        // an indented line belongs to the item above: its wrapped text, or a nested list
        if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) { items[items.length - 1].push(lines[i]); i++; continue; }
        break;
      }
      const html = items.map((parts) => {
        const [first, ...rest] = parts;
        const nested = rest.filter((r) => /^\s*[-*]\s/.test(r));
        const wrapped = rest.filter((r) => !/^\s*[-*]\s/.test(r)).map((r) => r.trim());
        const sub = nested.length
          ? `<ul>${nested.map((r) => `<li>${inline(r.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`
          : '';
        return `<li>${inline([first, ...wrapped].join(' '))}${sub}</li>`;
      }).join('');
      out.push(ordered ? `<ol>${html}</ol>` : `<ul>${html}</ul>`);
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}
