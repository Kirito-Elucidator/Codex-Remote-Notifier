import { timingSafeEqual } from 'crypto';

export function validateToken(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) {
    return false;
  }
  const a = Buffer.from(provided, 'utf-8');
  const b = Buffer.from(expected, 'utf-8');
  return timingSafeEqual(a, b);
}

export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}
