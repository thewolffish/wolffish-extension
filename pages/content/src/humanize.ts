const randomDelay = (min: number, max: number): number => Math.floor(Math.random() * (max - min + 1)) + min;

const sleep = async (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const isInputLike = (el: HTMLElement): boolean => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';

const humanizedType = async (element: HTMLElement, text: string, clearFirst: boolean): Promise<void> => {
  element.focus();

  if (clearFirst) {
    if (isInputLike(element)) {
      (element as HTMLInputElement).value = '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (element.isContentEditable) {
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
    }
  }

  for (const char of text) {
    const eventInit: KeyboardEventInit = {
      key: char,
      code: `Key${char.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
    };

    element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    element.dispatchEvent(new KeyboardEvent('keypress', eventInit));

    if (isInputLike(element)) {
      (element as HTMLInputElement).value += char;
    } else if (element.isContentEditable) {
      document.execCommand('insertText', false, char);
    }

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    await sleep(randomDelay(30, 100));
  }

  element.dispatchEvent(new Event('change', { bubbles: true }));
};

const dispatchClick = async (element: HTMLElement): Promise<void> => {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });

  await sleep(100);

  const rect = element.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    button: 0,
  };

  element.dispatchEvent(new MouseEvent('mousedown', eventInit));
  element.dispatchEvent(new MouseEvent('mouseup', eventInit));
  element.dispatchEvent(new MouseEvent('click', eventInit));
};

export { randomDelay, sleep, humanizedType, dispatchClick };
