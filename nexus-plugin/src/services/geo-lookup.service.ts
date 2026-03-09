import axios from 'axios';
import { createLogger } from '../utils/logger';

const logger = createLogger({ component: 'geo-lookup' });

export interface GeoData {
  country: string;
  countryCode: string;
  region: string;
  city: string;
  timezone: string;
  isp: string;
}

const EMPTY_GEO: GeoData = {
  country: 'Unknown',
  countryCode: '',
  region: '',
  city: '',
  timezone: '',
  isp: '',
};

const INTERNAL_GEO: GeoData = {
  country: 'Internal',
  countryCode: '',
  region: '',
  city: 'K8s Cluster',
  timezone: '',
  isp: 'Internal Network',
};

interface CacheEntry {
  data: GeoData;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_SIZE = 1000;

// Rate limiter: max 40 requests per minute to ip-api.com
let requestCount = 0;
let windowStart = Date.now();
const MAX_REQUESTS_PER_MIN = 40;

function isPrivateIP(ip: string): boolean {
  return (
    ip.startsWith('10.') ||
    ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') || ip.startsWith('172.20.') || ip.startsWith('172.21.') ||
    ip.startsWith('172.22.') || ip.startsWith('172.23.') || ip.startsWith('172.24.') ||
    ip.startsWith('172.25.') || ip.startsWith('172.26.') || ip.startsWith('172.27.') ||
    ip.startsWith('172.28.') || ip.startsWith('172.29.') || ip.startsWith('172.30.') ||
    ip.startsWith('172.31.') ||
    ip.startsWith('192.168.') ||
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === 'localhost'
  );
}

function cleanIP(raw: string): string {
  // Strip port if present (e.g., "1.2.3.4:54321" -> "1.2.3.4")
  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx > 0 && !raw.includes('[')) {
    // IPv4 with port
    return raw.substring(0, colonIdx);
  }
  // Strip brackets from IPv6
  return raw.replace(/^\[|\]$/g, '');
}

function checkRateLimit(): boolean {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    requestCount = 0;
    windowStart = now;
  }
  if (requestCount >= MAX_REQUESTS_PER_MIN) {
    return false;
  }
  requestCount++;
  return true;
}

export async function lookupGeo(rawIP: string): Promise<GeoData> {
  const ip = cleanIP(rawIP);

  if (!ip || isPrivateIP(ip)) {
    return INTERNAL_GEO;
  }

  // Check cache
  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  // Rate limit check
  if (!checkRateLimit()) {
    logger.warn('Geo-lookup rate limit reached, returning cached or empty', { ip });
    return cached?.data || EMPTY_GEO;
  }

  try {
    // Primary: ip-api.com (free, no key needed)
    const resp = await axios.get(
      `http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,timezone,isp`,
      { timeout: 3000 }
    );

    if (resp.data?.status === 'success') {
      const geo: GeoData = {
        country: resp.data.country || '',
        countryCode: resp.data.countryCode || '',
        region: resp.data.regionName || '',
        city: resp.data.city || '',
        timezone: resp.data.timezone || '',
        isp: resp.data.isp || '',
      };

      // Cache result
      if (cache.size >= MAX_CACHE_SIZE) {
        // Evict oldest entry
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
      }
      cache.set(ip, { data: geo, expiresAt: Date.now() + CACHE_TTL_MS });

      return geo;
    }
  } catch (err) {
    logger.warn('ip-api.com lookup failed, trying fallback', { ip, error: (err as Error).message });
  }

  // Fallback: ipapi.co
  try {
    const resp = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 3000 });

    if (resp.data && !resp.data.error) {
      const geo: GeoData = {
        country: resp.data.country_name || '',
        countryCode: resp.data.country_code || '',
        region: resp.data.region || '',
        city: resp.data.city || '',
        timezone: resp.data.timezone || '',
        isp: resp.data.org || '',
      };

      cache.set(ip, { data: geo, expiresAt: Date.now() + CACHE_TTL_MS });
      return geo;
    }
  } catch (err) {
    logger.warn('ipapi.co fallback also failed', { ip, error: (err as Error).message });
  }

  return EMPTY_GEO;
}
