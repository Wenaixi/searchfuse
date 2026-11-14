import { describe, expect, it } from 'vitest';
import { canonicalUrl } from './canonicalUrl.ts';

// The fusion key. Two engines naming the same page in slightly different
// spellings must land on one entry, or the fusion double-counts the page and
// the model reads it as two corroborating sources.
describe('canonicalUrl', () => {
  it('drops tracking parameters that do not change the page', () => {
    expect(canonicalUrl('https://x.example/a?utm_source=feed&utm_medium=rss')).toBe(
      'https://x.example/a',
    );
    expect(canonicalUrl('https://x.example/a?fbclid=abc&gclid=def')).toBe('https://x.example/a');
    expect(canonicalUrl('https://x.example/a?ref=homepage')).toBe('https://x.example/a');
    expect(canonicalUrl('https://x.example/a?spm=123&mc_cid=x&mc_eid=y')).toBe(
      'https://x.example/a',
    );
  });

  it('keeps parameters that select different content', () => {
    expect(canonicalUrl('https://x.example/search?q=rust&page=2')).toBe(
      'https://x.example/search?page=2&q=rust',
    );
    expect(canonicalUrl('https://x.example/a?id=7')).toBe('https://x.example/a?id=7');
  });

  it('sorts surviving parameters so order does not split one entry into two', () => {
    expect(canonicalUrl('https://x.example/a?b=2&a=1')).toBe('https://x.example/a?a=1&b=2');
    expect(canonicalUrl('https://x.example/a?a=1&b=2')).toBe('https://x.example/a?a=1&b=2');
  });

  it('drops the fragment, which never selects a different document', () => {
    expect(canonicalUrl('https://x.example/a#section-2')).toBe('https://x.example/a');
  });

  it('lower-cases the host only, not the path', () => {
    expect(canonicalUrl('https://X.Example/A/Path')).toBe('https://x.example/A/Path');
  });

  it('keeps a trailing slash difference merged', () => {
    expect(canonicalUrl('https://x.example/a/')).toBe('https://x.example/a');
    expect(canonicalUrl('https://x.example/')).toBe('https://x.example/');
  });

  it('does not merge distinct hosts that merely share a name', () => {
    // www.example.com and example.com serve different things often enough
    // that merging them would lose a real second source.
    expect(canonicalUrl('https://www.example.com/a')).toBe('https://www.example.com/a');
    expect(canonicalUrl('https://example.com/a')).toBe('https://example.com/a');
  });

  it('keeps the default port out and a non-default port in', () => {
    expect(canonicalUrl('https://x.example:443/a')).toBe('https://x.example/a');
    expect(canonicalUrl('https://x.example:8443/a')).toBe('https://x.example:8443/a');
  });

  it('returns anything unparseable unchanged rather than throwing', () => {
    // A provider can hand back a malformed URL. The fusion must survive it:
    // the entry stays visible under its own spelling instead of aborting a
    // whole search.
    expect(canonicalUrl('not a url')).toBe('not a url');
    expect(canonicalUrl('')).toBe('');
  });
});
