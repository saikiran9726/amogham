/**
 * CSV Security & Escaping Utilities
 * Protects against CSV / Spreadsheet Formula Injection (CWE-1236)
 * Prefixes cells beginning with =, +, -, @, tab, or carriage return with a single quote (')
 */

const FORMULA_INJECTION_PREFIX_REGEX = /^[=+\-@\t\r]/;

/**
 * Escapes a cell value to prevent CSV formula injection and formats it safely for CSV output.
 * If the value starts with =, +, -, @, \t, or \r, it is prefixed with a single quote.
 * Any double quotes inside the value are doubled according to RFC 4180.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '""';
  }

  let str = String(value);

  // If the cell begins with dangerous formula triggers, prefix with '
  if (FORMULA_INJECTION_PREFIX_REGEX.test(str)) {
    str = `'${str}`;
  }

  // Double up any quotes and wrap in quotes
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Sanitizes an unquoted cell or string value directly (e.g. for imports or table cell arrays).
 */
export function sanitizeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (FORMULA_INJECTION_PREFIX_REGEX.test(str)) {
    return `'${str}`;
  }
  return str;
}
