import { describe, it, expect } from 'vitest';
import { resolveApiBaseUrl, isSafeLocalOrPrivateHost, validateHubAddress } from '../api-base.js';

describe('API Base URL Configuration', () => {
  it('throws in production when VITE_API_BASE_URL is missing', () => {
    expect(() => resolveApiBaseUrl(undefined, true)).toThrow(
      'VITE_API_BASE_URL environment variable is required in production',
    );
    expect(() => resolveApiBaseUrl('', true)).toThrow(
      'VITE_API_BASE_URL environment variable is required in production',
    );
    expect(() => resolveApiBaseUrl('   ', true)).toThrow(
      'VITE_API_BASE_URL environment variable is required in production',
    );
  });

  it('defaults to http://localhost:4000 in development/test when missing', () => {
    expect(resolveApiBaseUrl(undefined, false)).toBe('http://localhost:4000');
    expect(resolveApiBaseUrl('', false)).toBe('http://localhost:4000');
    expect(resolveApiBaseUrl('   ', false)).toBe('http://localhost:4000');
  });

  it('normalizes provided URL by trimming and stripping trailing slashes', () => {
    expect(resolveApiBaseUrl('https://api.restaurantos.com/   ', true)).toBe(
      'https://api.restaurantos.com',
    );
    expect(resolveApiBaseUrl('http://192.168.1.100:4000///', false)).toBe(
      'http://192.168.1.100:4000',
    );
  });
});

describe('Private/Local Host Identification', () => {
  it('identifies loopback and localhost as safe', () => {
    expect(isSafeLocalOrPrivateHost('localhost')).toBe(true);
    expect(isSafeLocalOrPrivateHost('127.0.0.1')).toBe(true);
    expect(isSafeLocalOrPrivateHost('::1')).toBe(true);
    expect(isSafeLocalOrPrivateHost('[::1]')).toBe(true);
  });

  it('identifies RFC 1918 and link-local IPv4 subnets as safe', () => {
    expect(isSafeLocalOrPrivateHost('10.0.0.1')).toBe(true);
    expect(isSafeLocalOrPrivateHost('10.255.255.254')).toBe(true);
    expect(isSafeLocalOrPrivateHost('172.16.0.1')).toBe(true);
    expect(isSafeLocalOrPrivateHost('172.31.255.255')).toBe(true);
    expect(isSafeLocalOrPrivateHost('192.168.1.1')).toBe(true);
    expect(isSafeLocalOrPrivateHost('169.254.1.1')).toBe(true);
  });

  it('identifies mDNS and local network suffixes as safe', () => {
    expect(isSafeLocalOrPrivateHost('kitchen-printer.local')).toBe(true);
    expect(isSafeLocalOrPrivateHost('hub.lan')).toBe(true);
    expect(isSafeLocalOrPrivateHost('server.internal')).toBe(true);
    expect(isSafeLocalOrPrivateHost('pos.home.arpa')).toBe(true);
  });

  it('rejects public/WAN IP addresses and domain names', () => {
    expect(isSafeLocalOrPrivateHost('8.8.8.8')).toBe(false);
    expect(isSafeLocalOrPrivateHost('1.1.1.1')).toBe(false);
    expect(isSafeLocalOrPrivateHost('172.15.0.1')).toBe(false);
    expect(isSafeLocalOrPrivateHost('172.32.0.1')).toBe(false);
    expect(isSafeLocalOrPrivateHost('api.restaurantos.com')).toBe(false);
    expect(isSafeLocalOrPrivateHost('evil-attacker.com')).toBe(false);
  });
});

describe('Hub Address Validation', () => {
  it('rejects empty input', () => {
    expect(validateHubAddress('').valid).toBe(false);
    expect(validateHubAddress('   ').valid).toBe(false);
  });

  it('rejects embedded credentials', () => {
    const res1 = validateHubAddress('http://admin:secret@192.168.1.10:4000');
    expect(res1.valid).toBe(false);
    expect(res1.error).toContain('Embedded credentials');

    const res2 = validateHubAddress('https://user@pos.restaurant.internal');
    expect(res2.valid).toBe(false);
    expect(res2.error).toContain('Embedded credentials');
  });

  it('rejects non-HTTP(S) protocols', () => {
    const res = validateHubAddress('ftp://192.168.1.100');
    expect(res.valid).toBe(false);
    expect(res.error).toContain('Unsupported protocol');
  });

  it('rejects insecure HTTP for public/WAN addresses', () => {
    const res1 = validateHubAddress('http://api.restaurantos.com');
    expect(res1.valid).toBe(false);
    expect(res1.error).toContain(
      'Insecure HTTP cleartext is permitted only for safe local/private network ranges',
    );

    const res2 = validateHubAddress('http://8.8.8.8:4000');
    expect(res2.valid).toBe(false);
    expect(res2.error).toContain(
      'Insecure HTTP cleartext is permitted only for safe local/private network ranges',
    );
  });

  it('allows HTTP for private/local IP subnets and mDNS', () => {
    const res1 = validateHubAddress('http://192.168.1.50:4000');
    expect(res1.valid).toBe(true);
    expect(res1.normalizedUrl).toBe('http://192.168.1.50:4000');

    const res2 = validateHubAddress('192.168.1.50:4000');
    expect(res2.valid).toBe(true);
    expect(res2.normalizedUrl).toBe('http://192.168.1.50:4000');

    const res3 = validateHubAddress('http://pos-hub.local:3000/');
    expect(res3.valid).toBe(true);
    expect(res3.normalizedUrl).toBe('http://pos-hub.local:3000');
  });

  it('allows HTTPS for any valid domain or IP', () => {
    const res1 = validateHubAddress('https://api.restaurantos.com');
    expect(res1.valid).toBe(true);
    expect(res1.normalizedUrl).toBe('https://api.restaurantos.com');

    const res2 = validateHubAddress('https://hub.internal:8443/hub');
    expect(res2.valid).toBe(true);
    expect(res2.normalizedUrl).toBe('https://hub.internal:8443/hub');
  });
});
