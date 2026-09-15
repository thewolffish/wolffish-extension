import type { BrowserFillFormResult, BrowserFillResult, ElementTarget, FillKind } from '@extension/shared';

/**
 * Framework-safe field filling (contract §1 Filling). Inputs go through the
 * native prototype setter + `input`/`change` so React-style controlled fields
 * see the change; checkboxes are toggled with a real click for the same
 * reason; selects match by visible text or value.
 */

type Resolver = (target: ElementTarget) => HTMLElement;

const CHECKED_ERROR = 'Checkbox/radio values must be "true" or "false".';

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

const fire = (el: HTMLElement, names: string[]) => {
  for (const n of names) el.dispatchEvent(new Event(n, { bubbles: true }));
};

const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
};

const fillElement = (el: HTMLElement, value: string): { value: string; kind: FillKind } => {
  const tag = el.tagName.toLowerCase();
  el.focus();

  if (tag === 'select') {
    const select = el as HTMLSelectElement;
    const want = norm(value);
    const option = Array.from(select.options).find(
      o => norm(o.textContent ?? '') === want || norm(o.value) === want || norm(o.label) === want,
    );
    if (!option) {
      const listed = Array.from(select.options)
        .map(o => (o.textContent ?? '').trim() || o.value)
        .slice(0, 20)
        .join(', ');
      throw new Error(`No option matching "${value}" in <select> (options: ${listed}).`);
    }
    select.value = option.value;
    fire(el, ['input', 'change']);
    return { value: option.value, kind: 'select' };
  }

  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if (value !== 'true' && value !== 'false') throw new Error(CHECKED_ERROR);
      const want = value === 'true';
      if (input.checked !== want) {
        // A click flips the state AND fires the change event through the
        // framework's own handlers; setting .checked alone is invisible to them.
        if (want || type === 'checkbox') input.click();
        else {
          input.checked = false;
          fire(el, ['input', 'change']);
        }
      }
      return { value: String(input.checked), kind: type };
    }
    if (type === 'file') throw new Error('Element is not fillable (tag <input type="file">). Use ext_file_upload.');
    setNativeValue(input, value);
    fire(el, ['input', 'change']);
    return { value: input.value, kind: 'input' };
  }

  if (tag === 'textarea') {
    setNativeValue(el as HTMLTextAreaElement, value);
    fire(el, ['input', 'change']);
    return { value: (el as HTMLTextAreaElement).value, kind: 'textarea' };
  }

  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, value);
    fire(el, ['input']);
    return { value, kind: 'contenteditable' };
  }

  throw new Error(`Element is not fillable (tag <${tag}>).`);
};

const handleFill = async (params: Record<string, unknown>, resolve: Resolver): Promise<BrowserFillResult> => {
  const el = resolve({ uid: params.uid as string | undefined, selector: params.selector as string | undefined });
  const result = fillElement(el, String(params.value ?? ''));
  return { success: true, ...result };
};

const refOf = (target: ElementTarget, index: number): string => target.uid ?? target.selector ?? `#${index}`;

/** Partial success: every field is attempted; the wire fails only when all do. */
const handleFillForm = async (params: Record<string, unknown>, resolve: Resolver): Promise<BrowserFillFormResult> => {
  const elements = params.elements as Array<ElementTarget & { value: string }> | undefined;
  if (!Array.isArray(elements) || elements.length === 0) throw new Error('elements must be a non-empty array.');

  let filled = 0;
  const failures: Array<{ ref: string; error: string }> = [];
  for (const [i, entry] of elements.entries()) {
    try {
      const el = resolve({ uid: entry.uid, selector: entry.selector });
      fillElement(el, String(entry.value ?? ''));
      filled++;
    } catch (err) {
      failures.push({ ref: refOf(entry, i), error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (filled === 0) {
    throw new Error(`All ${elements.length} field(s) failed: ${failures.map(f => `${f.ref}: ${f.error}`).join(' | ')}`);
  }
  return { success: true, filled, failures };
};

export { fillElement, handleFill, handleFillForm };
