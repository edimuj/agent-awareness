import type { AwarenessPlugin, GatherContext, PluginConfig, Trigger } from '../core/types.ts';

// WMO weather codes → description
const WMO: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow',
  80: 'rain showers', 81: 'heavy showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm + hail', 99: 'severe thunderstorm',
};

interface GeoLocation {
  lat: number;
  lon: number;
  city: string;
}

export default {
  name: 'weather',
  description: 'Local weather conditions from Open-Meteo API (no API key needed)',
  triggers: ['session-start', 'change:hour'],

  defaults: {
    // When omitted, auto-detected via IP geolocation
    // latitude: 59.33,
    // longitude: 18.07,
    // city: 'Stockholm',
    showTemp: true,
    showFeelsLike: true,
    showCondition: true,
    showWind: true,
    showSunset: true,
    feelsLikeDelta: 3,        // only show "feels like" when diff >= this
    // Only inject when conditions changed since last injection
    onlyWhenChanged: false,
    triggers: {
      'session-start': true,
      'change:hour': true,
    },
  },

  async gather(trigger: Trigger, config: PluginConfig, prevState, _context: GatherContext) {
    // Resolve location: explicit config > cached geo > fresh geo lookup
    const location = await resolveLocation(config, prevState);
    if (!location) return null;

    const { lat, lon, city } = location;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m,weather_code,wind_speed_10m,apparent_temperature`
      + `&daily=sunset&timezone=auto&forecast_days=1`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const current = data.current;
      const temp = Math.round(current.temperature_2m);
      const feelsLike = Math.round(current.apparent_temperature);
      const wind = current.wind_speed_10m;
      const code = current.weather_code as number;
      const desc = WMO[code] ?? 'unknown';
      const sunset = data.daily?.sunset?.[0]?.slice(11, 16) ?? '';

      // Check if conditions changed (for onlyWhenChanged mode)
      if (config.onlyWhenChanged === true && prevState?.lastInjectedCode != null) {
        const sameTemp = prevState.lastInjectedTemp === temp;
        const sameCode = prevState.lastInjectedCode === code;
        if (sameTemp && sameCode) {
          return {
            text: '',
            state: { ...buildState(temp, code, lat, lon, city, prevState), lastInjectedTemp: prevState.lastInjectedTemp, lastInjectedCode: prevState.lastInjectedCode },
          };
        }
      }

      // Build output from enabled parts
      const parts: string[] = [`Weather ${city}:`];

      if (config.showTemp !== false) {
        const delta = (config.feelsLikeDelta as number) ?? 3;
        const feelsStr = config.showFeelsLike !== false && Math.abs(feelsLike - temp) >= delta
          ? ` (feels ${feelsLike}°)` : '';
        parts.push(`${temp}°C${feelsStr}`);
      }
      if (config.showCondition !== false) {
        parts.push(desc);
      }

      const extraParts: string[] = [];
      if (config.showWind !== false) {
        extraParts.push(`Wind: ${wind}km/h`);
      }
      if (config.showSunset !== false && sunset) {
        extraParts.push(`Sunset: ${sunset}`);
      }

      let text = parts.join(' ');
      if (extraParts.length > 0) {
        text += ` | ${extraParts.join(' | ')}`;
      }

      return {
        text,
        state: { ...buildState(temp, code, lat, lon, city, prevState), lastInjectedTemp: temp, lastInjectedCode: code },
      };
    } catch {
      // Stale data fallback
      if (prevState?.temp != null) {
        return {
          text: `Weather ${prevState.city ?? city}: ${prevState.temp}°C (cached)`,
          state: prevState as Record<string, unknown>,
        };
      }
      return null;
    }
  },
} satisfies AwarenessPlugin;

function buildState(temp: number, code: number, lat: number, lon: number, city: string, prevState: Record<string, unknown> | null): Record<string, unknown> {
  return { temp, code, lat, lon, city, lastFetch: new Date().toISOString() };
}

/** Resolve location from config, cached state, or IP geolocation. */
async function resolveLocation(
  config: PluginConfig,
  prevState: Record<string, unknown> | null,
): Promise<GeoLocation | null> {
  // 1. Explicit config — user knows best
  if (config.latitude != null && config.longitude != null) {
    return {
      lat: config.latitude as number,
      lon: config.longitude as number,
      city: (config.city as string) ?? 'Unknown',
    };
  }

  // 2. Cached from previous geo lookup (valid for 24h)
  if (prevState?.lat != null && prevState?.lon != null) {
    const lastFetch = prevState.lastFetch as string | undefined;
    const age = lastFetch ? Date.now() - new Date(lastFetch).getTime() : Infinity;
    if (age < 24 * 60 * 60_000) {
      return {
        lat: prevState.lat as number,
        lon: prevState.lon as number,
        city: (prevState.city as string) ?? 'Unknown',
      };
    }
  }

  // 3. Fresh IP geolocation
  return geolocate();
}

/** IP-based geolocation via ip-api.com (free, no key, 45 req/min). */
async function geolocate(): Promise<GeoLocation | null> {
  try {
    const res = await fetch('http://ip-api.com/json/?fields=lat,lon,city', {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.lat || !data.lon) return null;
    return { lat: data.lat, lon: data.lon, city: data.city ?? 'Unknown' };
  } catch {
    return null;
  }
}
