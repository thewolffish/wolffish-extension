const htmlToMarkdown = (element: Element): string => {
  const raw = processNode(element);
  return raw.replace(/\n{3,}/g, '\n\n').trim();
};

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'IFRAME']);

const isHidden = (el: Element): boolean => {
  if (SKIP_TAGS.has(el.tagName)) return true;
  const style = (el as HTMLElement).style;
  if (style?.display === 'none' || style?.visibility === 'hidden') return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.hasAttribute('hidden')) return true;
  return false;
};

const processNode = (node: Node): string => {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.replace(/\s+/g, ' ') ?? '';
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  if (isHidden(el)) return '';

  const tag = el.tagName;

  switch (tag) {
    case 'H1':
      return `# ${textOf(el)}\n\n`;
    case 'H2':
      return `## ${textOf(el)}\n\n`;
    case 'H3':
      return `### ${textOf(el)}\n\n`;
    case 'H4':
      return `#### ${textOf(el)}\n\n`;
    case 'H5':
      return `##### ${textOf(el)}\n\n`;
    case 'H6':
      return `###### ${textOf(el)}\n\n`;
    case 'P':
      return `${childrenToMd(el)}\n\n`;
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      const text = childrenToMd(el).trim();
      return `[${text}](${href})`;
    }
    case 'STRONG':
    case 'B':
      return `**${childrenToMd(el).trim()}**`;
    case 'EM':
    case 'I':
      return `*${childrenToMd(el).trim()}*`;
    case 'CODE':
      if (el.parentElement?.tagName === 'PRE') {
        return el.textContent ?? '';
      }
      return `\`${el.textContent ?? ''}\``;
    case 'PRE':
      return `\`\`\`\n${textOf(el)}\n\`\`\`\n\n`;
    case 'UL':
      return processListItems(el, false);
    case 'OL':
      return processListItems(el, true);
    case 'LI':
      return childrenToMd(el).trim();
    case 'IMG': {
      const alt = el.getAttribute('alt') ?? '';
      const src = el.getAttribute('src') ?? '';
      return `![${alt}](${src})`;
    }
    case 'BR':
      return '\n';
    case 'HR':
      return '---\n\n';
    case 'BLOCKQUOTE':
      return (
        childrenToMd(el)
          .trim()
          .split('\n')
          .map(line => `> ${line}`)
          .join('\n') + '\n\n'
      );
    case 'TABLE':
      return processTable(el);
    case 'DIV':
    case 'SPAN':
    case 'SECTION':
    case 'ARTICLE':
    case 'MAIN':
    case 'NAV':
    case 'HEADER':
    case 'FOOTER':
      return childrenToMd(el);
    default:
      return childrenToMd(el);
  }
};

const childrenToMd = (el: Element): string => {
  let result = '';
  for (const child of Array.from(el.childNodes)) {
    result += processNode(child);
  }
  return result;
};

const textOf = (el: Element): string => (el.textContent ?? '').trim();

const processListItems = (list: Element, ordered: boolean): string => {
  let result = '';
  let index = 1;
  for (const child of Array.from(list.children)) {
    if (child.tagName === 'LI') {
      const prefix = ordered ? `${index}. ` : '- ';
      result += `${prefix}${childrenToMd(child).trim()}\n`;
      index++;
    }
  }
  return result + '\n';
};

const processTable = (table: Element): string => {
  const rows: string[][] = [];
  const tableRows = table.querySelectorAll('tr');

  for (const tr of Array.from(tableRows)) {
    const cells: string[] = [];
    for (const cell of Array.from(tr.children)) {
      if (cell.tagName === 'TD' || cell.tagName === 'TH') {
        cells.push(childrenToMd(cell).trim());
      }
    }
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map(r => r.length));
  const normalized = rows.map(r => {
    while (r.length < colCount) r.push('');
    return r;
  });

  let result = '';

  result += '| ' + normalized[0].join(' | ') + ' |\n';
  result += '| ' + normalized[0].map(() => '---').join(' | ') + ' |\n';

  for (let i = 1; i < normalized.length; i++) {
    result += '| ' + normalized[i].join(' | ') + ' |\n';
  }

  return result + '\n';
};

export { htmlToMarkdown };
