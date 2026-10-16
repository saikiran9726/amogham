import { describe, it, expect } from 'vitest';
import { escapeCsvCell, sanitizeCsvValue } from './csv.js';

describe('CSV Formula Injection Prevention', () => {
  it('escapes standard values safely', () => {
    expect(escapeCsvCell('Paneer Butter Masala')).toBe('"Paneer Butter Masala"');
    expect(escapeCsvCell('123.45')).toBe('"123.45"');
    expect(escapeCsvCell(123)).toBe('"123"');
    expect(escapeCsvCell(null)).toBe('""');
    expect(escapeCsvCell(undefined)).toBe('""');
  });

  it('escapes double quotes according to RFC 4180', () => {
    expect(escapeCsvCell('Chef\'s "Special"')).toBe('"Chef\'s ""Special"""');
  });

  it('neutralizes formula injection characters (=, +, -, @, \\t, \\r)', () => {
    expect(escapeCsvCell("=cmd|' /C calc'!A0")).toBe("\"'=cmd|' /C calc'!A0\"");
    expect(escapeCsvCell('+1+1')).toBe('"\'+1+1"');
    expect(escapeCsvCell('-SUM(A1:A10)')).toBe('"\' -SUM(A1:A10)"'.replace(' ', ''));
    expect(escapeCsvCell('@SUM(A1:A10)')).toBe('"\'@SUM(A1:A10)"');
    expect(escapeCsvCell('\tmalicious')).toBe('"\'\tmalicious"');
    expect(escapeCsvCell('\rmalicious')).toBe('"\'\rmalicious"');
  });

  it('sanitizes unquoted raw values with sanitizeCsvValue', () => {
    expect(sanitizeCsvValue('=1+1')).toBe("'=1+1");
    expect(sanitizeCsvValue('normal text')).toBe('normal text');
    expect(sanitizeCsvValue(null)).toBe('');
  });
});
