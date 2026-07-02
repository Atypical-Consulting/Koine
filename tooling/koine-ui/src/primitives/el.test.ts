import { describe, expect, test, vi } from 'vitest';
import { el } from './el';

describe('el', () => {
  test('creates an element of the requested tag', () => {
    const node = el('button');
    expect(node).toBeInstanceOf(HTMLButtonElement);
    expect(node.tagName).toBe('BUTTON');
  });

  test('class sets className and text sets textContent', () => {
    const node = el('span', { class: 'koi-label', text: 'Hello' });
    expect(node.className).toBe('koi-label');
    expect(node.textContent).toBe('Hello');
  });

  test('html sets innerHTML', () => {
    const node = el('div', { html: '<b>x</b>' });
    expect(node.querySelector('b')?.textContent).toBe('x');
  });

  test('attrs are set via setAttribute; numbers stringify', () => {
    const node = el('div', { attrs: { role: 'switch', 'aria-label': 'Toggle', tabindex: 0 } });
    expect(node.getAttribute('role')).toBe('switch');
    expect(node.getAttribute('aria-label')).toBe('Toggle');
    expect(node.getAttribute('tabindex')).toBe('0');
  });

  test('a true attr becomes an empty boolean attribute; false/null/undefined are omitted', () => {
    const node = el('input', { attrs: { disabled: true, required: false, name: null, id: undefined } });
    expect(node.hasAttribute('disabled')).toBe(true);
    expect(node.getAttribute('disabled')).toBe('');
    expect(node.hasAttribute('required')).toBe(false);
    expect(node.hasAttribute('name')).toBe(false);
    expect(node.hasAttribute('id')).toBe(false);
  });

  test('on registers event listeners', () => {
    const onClick = vi.fn();
    const node = el('button', { on: { click: onClick } });
    node.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  test('children: strings become text nodes and Nodes are appended in order', () => {
    const node = el('div', {}, ['a', el('span', { text: 'b' }), 'c']);
    expect(node.childNodes).toHaveLength(3);
    expect(node.textContent).toBe('abc');
    expect(node.querySelector('span')?.textContent).toBe('b');
  });

  test('a single (non-array) child is accepted', () => {
    const node = el('div', {}, 'solo');
    expect(node.textContent).toBe('solo');
  });

  test('null / undefined / false children are skipped (conditional children)', () => {
    const show = false;
    const node = el('div', {}, ['keep', show && el('span'), null, undefined]);
    expect(node.childNodes).toHaveLength(1);
    expect(node.textContent).toBe('keep');
  });

  test('text is applied before children, so both render', () => {
    const node = el('div', { text: 'label: ' }, [el('strong', { text: 'value' })]);
    expect(node.textContent).toBe('label: value');
  });
});
