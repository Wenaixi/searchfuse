import { describe, expect, it } from 'vitest';
import { changelogSection } from './changelog.mjs';

const CHANGELOG = `# Changelog

## 3.3.0 - 2026-08-06

- newest entry body.

## 3.2.0 - 2026-08-05

- middle entry body line one.
- middle entry body line two.

## 3.1.0 - 2026-08-05

- oldest entry, nothing comes after it.
`;

describe('changelogSection', () => {
  it('extracts a middle section without bleeding into its neighbours', () => {
    const body = changelogSection(CHANGELOG, '3.2.0');
    expect(body).toContain('middle entry body line one.');
    expect(body).toContain('middle entry body line two.');
    expect(body).not.toContain('newest entry');
    expect(body).not.toContain('oldest entry');
  });

  it('extracts the last section, which the literal-Z anchor never matched', () => {
    const body = changelogSection(CHANGELOG, '3.1.0');
    expect(body).toContain('oldest entry, nothing comes after it.');
  });

  it('escapes the dots so a version cannot match a look-alike heading', () => {
    // Unescaped, the pattern for 1.2.3 would match the heading "1a2b3".
    expect(changelogSection('## 1a2b3 - x\n\nwrong body.\n', '1.2.3')).toBeNull();
  });

  it('reads the Keep a Changelog bracketed heading as well as the plain one', () => {
    // 新版用 `## [0.1.0] - 日期` 这种写法（方括号承载每版的 compare 链接），
    // 老版本与测试里的字面量仍是 `## 0.1.0 - 日期`。发布脚本要能读两种。
    const bracketed = `# Changelog

## [0.2.0] - 2026-11-20

- bracketed body.

## 0.1.0 - 2026-11-18

- plain body.
`;
    expect(changelogSection(bracketed, '0.2.0')).toContain('bracketed body.');
    expect(changelogSection(bracketed, '0.1.0')).toContain('plain body.');
    // 方括号里的内容仍然要是那个版本号，不能被前缀骗过去。
    expect(changelogSection(bracketed, '0.1')).toBeNull();
  });

  it('returns null when the version is absent', () => {
    expect(changelogSection(CHANGELOG, '9.9.9')).toBeNull();
  });
});
