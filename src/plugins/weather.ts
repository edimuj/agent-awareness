import type { AwarenessPlugin, PluginConfig, Trigger } from '../core/types.ts';

// WMO weather codes → emoji + description
const WMO: Record<number, [string, string]> = {
  0: ['☀️', 'clear'], 1: ['🌤', 'mostly clear'], 2: ['⛅', 'partly cloudy'], 3: ['☁️', 'overcast'],
  45: ['🌫', 'fog'], 48: ['🌫', 'rime fog'],
  51: ['🌦', 'light drizzle'], 53: ['🌦', 'drizzle'], 55: ['🌧', 'heavy drizzle'],
  61: ['🌧', 'light rain'], 63: ['🌧', 'rain'], 65: ['🌧', 'heavy rain'],
  71: ['🌨', 'light snow'], 73: ['🌨', 'snow'], 75: ['🌨', 'heavy snow'],
  80: ['🌧', 'rain showers'], 81: ['🌧', 'heavy showers'], 82: ['🌧', 'violent showers'],
  85: ['🌨', 'snow showers'], 86: ['🌨', 'heavy snow showers'],
  95: ['⛈', 'thunderstorm'], 96: ['⛈', 'thunderstorm + hail'], 99: ['⛈', 'severe thunderstorm'],
};

export default {
  name: 'weather',
  description: 'Local weather conditions from Open-Meteo API (no API key needed)',
  triggers: ['session-start', 'change:hour'],

  defaults: {
    latitude: 59.33,   // Stockholm
    longitude: 18.07,
    city: 'Stockholm',
    triggers: {
      'session-start': true,
      'change:hour': true,
    },
  },

  async gather(trigger: Trigger, config: PluginConfig, prevState) {
    const lat = (config.latitude as number) ?? 59.33;
    const lon = (config.longitude as number) ?? 18.07;
    const city = (config.city as string) ?? 'Stockholm';

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
      const [emoji, desc] = WMO[code] ?? ['🌡', 'unknown'];

      const sunset = data.daily?.sunset?.[0]?.slice(11, 16) ?? '';

      const feelsStr = Math.abs(feelsLike - temp) >= 3 ? ` (feels ${feelsLike}°)` : '';
      const sunsetStr = sunset ? ` | Sunset: ${sunset}` : '';

      return {
        text: `${emoji} ${city}: ${temp}°C${feelsStr}, ${desc} | Wind: ${wind}km/h${sunsetStr}`,
        state: { temp, code, lastFetch: new Date().toISOString() },
      };
    } catch {
      // Stale data fallback
      if (prevState?.temp != null) {
        return {
          text: `🌡 ${city}: ${prevState.temp}°C (cached)`,
          state: prevState as Record<string, unknown>,
        };
      }
      return { text: '', state: {} };
    }
  },
} satisfies AwarenessPlugin;
