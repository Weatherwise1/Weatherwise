import { writeFileSync } from "fs";

// ─── Coordinates for Hyderabad ───────────────────────────────────────────────
const LAT = 17.385;
const LON = 78.4867;

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Source 1: Open-Meteo ICON model (no key needed) ─────────────────────────
async function getOpenMeteoICON() {
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LAT}&longitude=${LON}` +
    `&current=temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m,is_day` +
    `&hourly=precipitation_probability,temperature_2m,weather_code` +
    `&models=icon_seamless` +
    `&forecast_days=1&timezone=Asia%2FKolkata`;
  const data = await fetchWithTimeout(url);
  const cur = data.current;
  const nowIdx = data.hourly.time.findIndex(t => t.startsWith(cur.time.slice(0, 13)));
  const next6 = data.hourly.precipitation_probability.slice(nowIdx, nowIdx + 6);
  return {
    source: "Open-Meteo ICON",
    temp: Math.round(cur.temperature_2m),
    humidity: cur.relative_humidity_2m,
    wind: Math.round(cur.wind_speed_10m),
    precipNow: cur.precipitation > 0,
    chanceOfRain: next6.length ? Math.max(...next6) : 0,
    weatherCode: cur.weather_code,
    isDay: cur.is_day === 1,
  };
}

// ─── Source 2: Open-Meteo ECMWF model (no key needed) ────────────────────────
async function getOpenMeteoECMWF() {
  const url = `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${LAT}&longitude=${LON}` +
    `&current=temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m` +
    `&hourly=precipitation_probability,temperature_2m,weather_code` +
    `&models=ecmwf_ifs025` +
    `&forecast_days=1&timezone=Asia%2FKolkata`;
  const data = await fetchWithTimeout(url);
  const cur = data.current;
  const nowIdx = data.hourly.time.findIndex(t => t.startsWith(cur.time.slice(0, 13)));
  const next6 = data.hourly.precipitation_probability.slice(nowIdx, nowIdx + 6);
  return {
    source: "Open-Meteo ECMWF",
    temp: Math.round(cur.temperature_2m),
    humidity: cur.relative_humidity_2m,
    wind: Math.round(cur.wind_speed_10m),
    precipNow: cur.precipitation > 0,
    chanceOfRain: next6.length ? Math.max(...next6) : 0,
    weatherCode: cur.weather_code,
  };
}

// ─── Source 3: WeatherAPI.com ─────────────────────────────────────────────────
async function getWeatherAPI() {
  const key = process.env.WEATHERAPI_KEY;
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${key}&q=${LAT},${LON}&days=1&aqi=yes`;
  const data = await fetchWithTimeout(url);
  const cur = data.current;
  return {
    source: "WeatherAPI",
    temp: Math.round(cur.temp_c),
    humidity: cur.humidity,
    wind: Math.round(cur.wind_kph),
    precipNow: cur.precip_mm > 0,
    chanceOfRain: data.forecast.forecastday[0].hour
      .slice(new Date().getHours(), new Date().getHours() + 6)
      .reduce((max, h) => Math.max(max, h.chance_of_rain), 0),
    conditionText: cur.condition.text,
    uv: cur.uv,
    feelsLike: Math.round(cur.feelslike_c),
    airQuality: cur.air_quality ? Math.round(cur.air_quality.pm2_5) : null,
  };
}

// ─── Source 4: Tomorrow.io ────────────────────────────────────────────────────
async function getTomorrow() {
  const key = process.env.TOMORROW_KEY;
  const url = `https://api.tomorrow.io/v4/weather/realtime?location=${LAT},${LON}&units=metric`;
const data = await fetchWithTimeout(url, {
  headers: { 
    "apikey": key,
    "Accept": "application/json"
  }
});
  const v = data.data.values;
  return {
    source: "Tomorrow.io",
    temp: Math.round(v.temperature),
    humidity: Math.round(v.humidity),
    wind: Math.round(v.windSpeed * 3.6), // m/s to km/h
    precipNow: v.precipitationIntensity > 0,
    chanceOfRain: Math.round(v.precipitationProbability),
    visibility: v.visibility,
    uvIndex: v.uvIndex,
    feelsLike: Math.round(v.temperatureApparent),
  };
}

// ─── Reconciliation engine ────────────────────────────────────────────────────
function reconcile(results) {
  const good = results.filter(r => r.status === "ok").map(r => r.data);
  const failed = results.filter(r => r.status === "error").map(r => r.source);

  if (good.length === 0) throw new Error("All sources failed");

  // Average temperature across all good sources
  const avgTemp = Math.round(good.reduce((s, d) => s + d.temp, 0) / good.length);

  // Average humidity
  const avgHumidity = Math.round(good.reduce((s, d) => s + d.humidity, 0) / good.length);

  // Average wind
  const avgWind = Math.round(good.reduce((s, d) => s + d.wind, 0) / good.length);

  // Chance of rain: take the highest value (conservative — better to warn than miss)
  const maxRain = Math.max(...good.map(d => d.chanceOfRain));

  // Temp spread — how much do sources disagree on temperature?
  const temps = good.map(d => d.temp);
  const tempSpread = Math.max(...temps) - Math.min(...temps);

  // Rain agreement — are sources pointing the same direction?
  const wetVotes = good.filter(d => d.chanceOfRain > 40 || d.precipNow).length;
  const dryVotes = good.filter(d => d.chanceOfRain < 20 && !d.precipNow).length;
  const totalVotes = good.length;

  let rainAgreement, confidence;
  if (wetVotes === totalVotes) {
    rainAgreement = "all_wet";
    confidence = "high";
  } else if (dryVotes === totalVotes) {
    rainAgreement = "all_dry";
    confidence = "high";
  } else if (wetVotes > totalVotes / 2) {
    rainAgreement = "mostly_wet";
    confidence = "medium";
  } else if (dryVotes > totalVotes / 2) {
    rainAgreement = "mostly_dry";
    confidence = "medium";
  } else {
    rainAgreement = "split";
    confidence = "low";
  }

  // If sources disagree a lot on temp, downgrade confidence
  if (tempSpread >= 3) confidence = "low";

  // Is it day or night?
  const isDay = good.find(d => d.isDay !== undefined)?.isDay ?? true;

  // Extra fields from whichever source has them
  const uv = good.find(d => d.uvIndex)?.uvIndex
           ?? good.find(d => d.uv)?.uv
           ?? null;
  const feelsLike = good.find(d => d.feelsLike)?.feelsLike ?? null;
  const airQuality = good.find(d => d.airQuality)?.airQuality ?? null;

  // Determine overall condition label
  let condition;
  if (rainAgreement === "all_wet" || rainAgreement === "mostly_wet") {
    condition = "rainy";
  } else if (rainAgreement === "all_dry" && avgTemp >= 30) {
    condition = "clear";
  } else if (rainAgreement === "all_dry") {
    condition = "clear";
  } else {
    condition = "cloudy";
  }

  return {
    city: "Hyderabad",
    temp: avgTemp,
    humidity: avgHumidity,
    wind: avgWind,
    chanceOfRain: maxRain,
    condition,
    isDay,
    confidence,
    rainAgreement,
    tempSpread,
    uv,
    feelsLike,
    airQuality,
    sourcesUsed: good.map(d => d.source),
    sourcesFailed: failed,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Fetching from all sources in parallel...\n");

  // Run all 4 fetches at once — don't let one slow/failed source delay others
  const results = await Promise.all([
    getOpenMeteoICON().then(d => ({ status: "ok", source: "Open-Meteo ICON", data: d }))
      .catch(e => ({ status: "error", source: "Open-Meteo ICON", error: e.message })),
    getOpenMeteoECMWF().then(d => ({ status: "ok", source: "Open-Meteo ECMWF", data: d }))
      .catch(e => ({ status: "error", source: "Open-Meteo ECMWF", error: e.message })),
    getWeatherAPI().then(d => ({ status: "ok", source: "WeatherAPI", data: d }))
      .catch(e => ({ status: "error", source: "WeatherAPI", error: e.message })),
    getTomorrow().then(d => ({ status: "ok", source: "Tomorrow.io", data: d }))
      .catch(e => ({ status: "error", source: "Tomorrow.io", error: e.message })),
  ]);

  // Show individual source results
  results.forEach(r => {
    if (r.status === "ok") {
      console.log(`✓ ${r.source}: ${r.data.temp}°C, ${r.data.chanceOfRain}% rain`);
    } else {
      console.log(`✗ ${r.source}: FAILED — ${r.error}`);
    }
  });

  console.log("\n--- Reconciled Result ---");
  const reconciled = reconcile(results);
  console.log(JSON.stringify(reconciled, null, 2));
  writeFileSync("weather.json", JSON.stringify(reconciled, null, 2));
console.log("\n✓ weather.json written successfully");
}

main();