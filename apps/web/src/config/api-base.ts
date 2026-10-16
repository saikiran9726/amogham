/**
 * Centralized API Base URL resolution and Hub Address validation.
 */

export function resolveApiBaseUrl(envUrl?: string, isProd?: boolean): string {
  const effectiveEnvUrl = arguments.length > 0 ? envUrl : import.meta.env.VITE_API_BASE_URL;
  const effectiveIsProd =
    arguments.length > 1 && isProd !== undefined ? isProd : Boolean(import.meta.env.PROD);

  if (!effectiveEnvUrl || effectiveEnvUrl.trim() === '') {
    if (effectiveIsProd) {
      throw new Error(
        'VITE_API_BASE_URL environment variable is required in production but was omitted.',
      );
    }
    return 'http://localhost:4000';
  }
  return effectiveEnvUrl.trim().replace(/\/+$/, '');
}

export const API_BASE_URL = resolveApiBaseUrl();

/**
 * Checks if a hostname belongs to RFC 1918 private subnets, loopback, or .local/.lan mDNS.
 */
export function isSafeLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  // Localhost / Loopback
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }

  // mDNS or local domain (.local, .lan, .internal, .home.arpa)
  if (
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return true;
  }

  // IPv4 Private Ranges:
  // 127.0.0.0/8
  // 10.0.0.0/8
  // 172.16.0.0/12 (172.16 - 172.31)
  // 192.168.0.0/16
  // 169.254.0.0/16 (Link-local)
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const match = host.match(ipv4Regex);
  if (match) {
    const o1 = Number(match[1]);
    const o2 = Number(match[2]);
    const o3 = Number(match[3]);
    const o4 = Number(match[4]);
    if ([o1, o2, o3, o4].some((o) => Number.isNaN(o) || o < 0 || o > 255)) return false;

    if (o1 === 127) return true;
    if (o1 === 10) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 169 && o2 === 254) return true;

    return false;
  }

  return false;
}

export interface HubValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  error?: string;
}

/**
 * Validates a hub address input.
 * Rules:
 * - Must be a valid URL (if no protocol is supplied, http:// is prepended for validation).
 * - Must NOT contain embedded credentials (username or password).
 * - Protocol must be https: OR http: strictly for safe local/private network ranges.
 * - Public/remote WAN addresses must strictly use https:.
 */
export function validateHubAddress(input: string): HubValidationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, error: 'Hub address cannot be empty' };
  }

  // Prepend protocol if missing for URL parsing
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const urlToParse = hasScheme ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(urlToParse);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Zero embedded credentials allowed
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: 'Embedded credentials (username/password) are not permitted in hub address',
    };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      valid: false,
      error: `Unsupported protocol "${protocol}". Only http: and https: are allowed.`,
    };
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return { valid: false, error: 'Hostname cannot be empty' };
  }

  // If HTTP, host MUST be a safe local or private network address
  if (protocol === 'http:') {
    if (!isSafeLocalOrPrivateHost(hostname)) {
      return {
        valid: false,
        error:
          'Insecure HTTP cleartext is permitted only for safe local/private network ranges (10.x, 172.16-31.x, 192.168.x, 127.x) or .local mDNS domains. Public addresses must use HTTPS.',
      };
    }
  }

  // Return normalized URL without trailing slash
  const normalized =
    `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(
      /\/+$/,
      '',
    );
  return { valid: true, normalizedUrl: normalized };
}
