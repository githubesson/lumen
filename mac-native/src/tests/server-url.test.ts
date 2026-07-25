import { describe, expect, it } from 'vitest';
import { normalizeServerUrl } from '../bootstrap/normalize-server-url';

describe('normalizeServerUrl', () => {
  it('defaults a bare host to https', () => {
    expect(normalizeServerUrl('lumen.example.com')).toBe('https://lumen.example.com');
  });

  it('keeps an explicit http scheme, so a LAN server still works', () => {
    expect(normalizeServerUrl('http://192.168.1.4:8080')).toBe(
      'http://192.168.1.4:8080',
    );
  });

  it('keeps an explicit https scheme', () => {
    expect(normalizeServerUrl('https://lumen.example.com')).toBe(
      'https://lumen.example.com',
    );
  });

  it('strips trailing slashes, which core would otherwise double up on', () => {
    expect(normalizeServerUrl('https://lumen.example.com///')).toBe(
      'https://lumen.example.com',
    );
  });

  it('trims surrounding whitespace from a pasted address', () => {
    expect(normalizeServerUrl('  lumen.example.com  ')).toBe(
      'https://lumen.example.com',
    );
  });

  it('treats blank input as unset rather than producing "https://"', () => {
    expect(normalizeServerUrl('')).toBe('');
    expect(normalizeServerUrl('   ')).toBe('');
  });

  it('preserves a path prefix for servers hosted under a subdirectory', () => {
    expect(normalizeServerUrl('example.com/lumen/')).toBe('https://example.com/lumen');
  });
});
