import { describe, expect, it } from 'vitest';
import { plainTextFromHeadingHtml } from '../scripts/docs-html-utils.mjs';

describe('docs heading HTML extraction', () => {
  it('removes the anchor and inline markup while preserving text', () => {
    expect(
      plainTextFromHeadingHtml(
        '<a class="anchor" href="#install" aria-label="Anchor link">#</a>Install <code>mcporter</code>'
      )
    ).toBe('Install mcporter');
  });

  it('does not create a script tag from nested attacker-controlled markup', () => {
    const text = plainTextFromHeadingHtml(
      '<a class="anchor" href="#safe" aria-label="Anchor link">#</a><scr<script>ipt>alert(1)</script>Safe'
    );

    expect(text).not.toContain('<script');
    expect(text).toContain('Safe');
  });
});
