/**
 * @fileoverview Tests for escapeMarkdown — the render-boundary escaper for
 * upstream text in content[]. Pins the exact escaped string for each construct
 * it neutralizes, the values it must leave byte-identical, the line-start
 * variant used where upstream text opens a list item, and linear running time.
 * @module tests/tools/markdown-escape.test
 */

import { describe, expect, it } from 'vitest';
import { escapeMarkdown, renderRunwayName } from '@/mcp-server/tools/definitions/_schemas.js';

describe('escapeMarkdown (inline)', () => {
  it.each([
    ['Lambari d`Oeste', 'Lambari d\\`Oeste'],
    ['GRASS&amp;GRAVEL', 'GRASS&amp;amp;GRAVEL'],
    ['(*)Kasteli Hellenic Air Force Base', '(\\*)Kasteli Hellenic Air Force Base'],
    ['Wau_NDB_', 'Wau_NDB\\_'],
    ['a `b` c', 'a \\`b\\` c'],
    ['*x*', '\\*x\\*'],
    ['_x_', '\\_x\\_'],
    ['[a](b)', '[a\\](b)'],
    ['a][b', 'a\\][b'],
    ['<b>x</b>', '\\<b>x\\</b>'],
    ['<!-- c -->', '\\<!-- c -->'],
    ['<?php', '\\<?php'],
    ['&copy;', '&amp;copy;'],
    ['&#65;', '&amp;#65;'],
    ['&#x41;', '&amp;#x41;'],
    ['~~x~~', '\\~\\~x\\~\\~'],
    ['back\\slash', 'back\\\\slash'],
    ['Field #', 'Field \\#'],
    ['A ###', 'A \\###'],
    ['#', '\\#'],
    ['*Offshore Platforms', '\\*Offshore Platforms'],
    ['A/G_', 'A/G\\_'],
    ['Café_', 'Café\\_'],
    ['x<', 'x\\<'],
    ['a_😀', 'a\\_😀'],
  ])('escapes %j as %j', (raw, escaped) => {
    expect(escapeMarkdown(raw)).toBe(escaped);
  });

  it.each([
    'Sahabat [Sahabat 16] Airport',
    'AT&T',
    'snake_case',
    'No. #2',
    'C#',
    'a < b > c',
    'x_名_y',
    '𝐀_𝐀',
    '𠀀_x_𠀀',
    '&#12345678;',
    'LEVC_N_TACC',
    'Bresso Radio [IT/EN]',
    'new! 8,33 !',
    'Seattle Tacoma International Airport',
    '- dash',
    '12. x',
    '',
  ])('leaves %j byte-identical', (raw) => {
    expect(escapeMarkdown(raw)).toBe(raw);
  });

  it('folds CR/LF runs to a single space', () => {
    expect(escapeMarkdown('line1\nline2')).toBe('line1 line2');
    expect(escapeMarkdown('a\r\nb')).toBe('a b');
  });

  it('escapes a trailing < that a following template character could turn into a tag', () => {
    // renderRunwayName joins the two ends with `/`: an unescaped `x<` + `/` + `b>`
    // would render as the raw HTML closing tag `</b>`.
    const runway = {
      id: 1,
      lengthFt: null,
      widthFt: null,
      surface: null,
      lighted: false,
      closed: false,
      leIdent: 'x<',
      leHeadingDegT: null,
      leDisplacedThresholdFt: null,
      heIdent: 'b>',
      heHeadingDegT: null,
      heDisplacedThresholdFt: null,
    };
    expect(renderRunwayName(runway)).toBe('x\\</b>');
  });
});

describe("escapeMarkdown (line-start: upstream text opening a list item's content)", () => {
  it.each([
    ['- dash', '\\- dash'],
    ['+ plus', '\\+ plus'],
    ['-', '\\-'],
    ['> quote', '\\> quote'],
    ['>q', '\\>q'],
    ['# h', '\\# h'],
    ['###### h', '\\###### h'],
    ['12. x', '12\\. x'],
    ['1) x', '1\\) x'],
    ['[x] y', '\\[x] y'],
    ['[ ] t', '\\[ ] t'],
    ['[^1]: y', '\\[^1]: y'],
    ['#', '\\#'],
    ['*x*', '\\*x\\*'],
  ])('escapes %j as %j', (raw, escaped) => {
    expect(escapeMarkdown(raw, 'line-start')).toBe(escaped);
  });

  it.each(['US-WA', 'NL-XX', '-x', '#h', '2.5 Mile', '[x]y', '####### h'])(
    'leaves %j byte-identical',
    (raw) => {
      expect(escapeMarkdown(raw, 'line-start')).toBe(raw);
    },
  );
});

describe('escapeMarkdown running time', () => {
  /** Worst cases: long runs of every character the escaper inspects, with no closer. */
  const worstCases: Record<string, (n: number) => string> = {
    backticks: (n) => '`'.repeat(n),
    stars: (n) => '*'.repeat(n),
    underscores: (n) => '_'.repeat(n),
    ampersands: (n) => '&'.repeat(n),
    ampersandNames: (n) => `&${'a'.repeat(31)}`.repeat(Math.ceil(n / 32)).slice(0, n),
    lessThans: (n) => '<'.repeat(n),
    hashes: (n) => '#'.repeat(n),
    mixed: (n) => '`*_&<]#\\~'.repeat(Math.ceil(n / 9)).slice(0, n),
  };

  /** Fastest of several runs — the least noisy estimate of the cost of one call. */
  const fastest = (input: string): number => {
    escapeMarkdown(input, 'line-start');
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 7; run++) {
      const started = performance.now();
      escapeMarkdown(input, 'line-start');
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  it.each(Object.entries(worstCases))(
    'scales linearly on %s (16x the input costs well under 64x the time)',
    (_name, build) => {
      const t5k = Math.max(fastest(build(5_000)), 0.05);
      const t80k = fastest(build(80_000));
      // Linear is ~16x; quadratic would be ~256x. 64x leaves headroom for timer noise.
      expect(t80k / t5k).toBeLessThan(64);
      expect(t80k).toBeLessThan(250);
    },
  );
});
