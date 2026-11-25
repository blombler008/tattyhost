import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Button, { ButtonLink } from '../src/components/Button';

test('shared buttons preserve native form, disabled and accessibility attributes', () => {
    const markup = renderToStaticMarkup(createElement(Button, {
        type: 'submit', variant: 'primary', disabled: true, 'aria-label': 'Save'
    }, 'Save'));
    assert.match(markup, /<button\b/);
    assert.match(markup, /type="submit"/);
    assert.match(markup, /disabled=""/);
    assert.match(markup, /aria-label="Save"/);
    assert.match(markup, /bg-sky-300/);
});

test('button links retain link semantics and the selected variant', () => {
    const markup = renderToStaticMarkup(createElement(ButtonLink, { href: '/download', variant: 'normal' }, 'Download'));
    assert.match(markup, /<a\b/);
    assert.match(markup, /href="\/download"/);
    assert.match(markup, /border-\[var\(--theme-border\)\]/);
});
