import { writeFileSync } from "fs";

// ─── Default Coordinates (Hyderabad Central) ─────────────────────────────────
const DEFAULT_LAT = 17.385;
const DEFAULT_LON = 78.4867;

// ─── WEATHERWISE ENSEMBLE ENGINE (PHASE 1) ─────────────────────────────────
function calculateMedian(values) {
  if (!values || values.length === 0) return null;
  const validValues = values.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
  if (validValues.length === 0) return null;
  const mid = Math.floor(validValues.length / 2);
  return validValues.length % 2 !== 0 ? validValues[mid] : Math.round((validValues[mid - 1] + validValues[mid]) / 2);
}

function calculateSpread(values) {
  if (!values || values.length < 2) return 0;
  const validValues = values.filter(v => v !== null && !isNaN(v));
  if (validValues.length < 2) return 0;
  return Math.round((Math.max(...validValues) - Math.min(...validValues)) * 10) / 10;
}

function calculateWindowRainProbability(hourlyProbabilities) {
  if (!hourlyProbabilities || hourlyProbabilities.length === 0) return 0;
  const validProbs = hourlyProbabilities.filter(p => p !== null && !isNaN(p)).map(p => p / 100);
  if (validProbs.length === 0) return 0;
  const lowerBound = Math.max(...validProbs);
  const probabilityNoRain = validProbs.reduce((acc, p) => acc * (1 - p), 1);
  const upperBound = 1 - probabilityNoRain;
  return Math.round(((lowerBound + upperBound) / 2) * 100);
}

function calculateRainConfidence(rainProbabilities, precipNow) {
  const total = rainProbabilities.length;
  if (total < 2) return { agreement: "single_source", confidenceText: "Limited data", confLevel: "low" };

  const wet = rainProbabilities.filter(p => p >= 40 || precipNow).length;
  const dry = rainProbabilities.filter(p => p <= 20 && !precipNow).length;
  
  if (wet === total || dry === total) return { agreement: wet === total ? "all_wet" : "all_dry", confidenceText: "Models agree", confLevel: "high" };
  if (wet > total / 2 || dry > total / 2) return { agreement: wet > total / 2 ? "mostly_wet" : "mostly_dry", confidenceText: "Models mostly agree", confLevel: "medium" };
  
  return { agreement: "split", confidenceText: "Models disagree", confLevel: "low" };
}

// ─── DATA VALIDATION & NORMALIZATION (PHASE 2 & 3) ─────────────────────────
function normalizeAndValidate(data, sourceName) {
  if (data.temp < -5 || data.temp > 55) throw new Error(`Unrealistic temperature detected (${data.temp}°C)`);
  if (data.humidity < 0 || data.humidity > 100) throw new Error(`Unrealistic humidity detected (${data.humidity}%)`);
  if (data.wind < 0 || data.wind > 200) throw new Error(`Unrealistic wind speed detected (${data.wind} km/h)`);
  if (data.chanceOfRain < 0 || data.chanceOfRain > 100) throw new Error(`Unrealistic rain probability detected (${data.chanceOfRain}%)`);
  
  return {
    source: sourceName,
    temp: Math.round(data.temp),
    humidity: Math.round(data.humidity),
    wind: Math.round(data.wind),
    precipNow: !!data.precipNow,
    chanceOfRain: Math.round(data.chanceOfRain),
    isDay: data.isDay !== undefined ? !!data.isDay : true,
    high: data.high != null ? Math.round(data.high) : null,
    low: data.low != null ? Math.round(data.low) : null,
    uv: data.uv != null ? data.uv : null,
    feelsLike: data.feelsLike != null ? Math.round(data.feelsLike) : null,
    airQuality: data.airQuality != null ? Math.round(data.airQuality) : null,
    validTime: data.validTime || null,
    ageMinutes: data.ageMinutes || 0,
  };
}

// ─── Fetch Helper with Timeout ───────────────────────────────────────────────
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

// ─── Data Fetchers (PHASE 3: Model Expansion & Freshness) ──────────────────
async function getOpenMeteoICON(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m,is_day&hourly=precipitation_probability,temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&models=icon_seamless&forecast_days=1&timezone=Asia%2FKolkata`;
  const data = await fetchWithTimeout(url);
  const cur = data.current;
  const nowIdx = data.hourly.time.findIndex(t => t.startsWith(cur.time.slice(0, 13)));
  const next6 = data.hourly.precipitation_probability.slice(nowIdx, nowIdx + 6);
  
  const ageMinutes = Math.floor((Date.now() - new Date(cur.time + "+05:30").getTime()) / 60000);

  return normalizeAndValidate({
    temp: cur.temperature_2m, humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m,
    precipNow: cur.precipitation > 0, chanceOfRain: calculateWindowRainProbability(next6),
    isDay: cur.is_day === 1, high: data.daily ? data.daily.temperature_2m_max[0] : null,
    low: data.daily ? data.daily.temperature_2m_min[0] : null,
    validTime: cur.time, ageMinutes: Math.max(0, ageMinutes),
  }, "Open-Meteo ICON");
}

async function getOpenMeteoECMWF(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m&hourly=precipitation_probability,temperature_2m,weather_code&models=ecmwf_ifs025&forecast_days=1&timezone=Asia%2FKolkata`;
  const data = await fetchWithTimeout(url);
  const cur = data.current;
  const nowIdx = data.hourly.time.findIndex(t => t.startsWith(cur.time.slice(0, 13)));
  const next6 = data.hourly.precipitation_probability.slice(nowIdx, nowIdx + 6);
  
  const ageMinutes = Math.floor((Date.now() - new Date(cur.time + "+05:30").getTime()) / 60000);

  return normalizeAndValidate({
    temp: cur.temperature_2m, humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m,
    precipNow: cur.precipitation > 0, chanceOfRain: calculateWindowRainProbability(next6),
    validTime: cur.time, ageMinutes: Math.max(0, ageMinutes),
  }, "Open-Meteo ECMWF");
}

async function getOpenMeteoGFS(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,weather_code,wind_speed_10m,relative_humidity_2m&hourly=precipitation_probability,temperature_2m,weather_code&models=gfs_seamless&forecast_days=1&timezone=Asia%2FKolkata`;
  const data = await fetchWithTimeout(url);
  const cur = data.current;
  const nowIdx = data.hourly.time.findIndex(t => t.startsWith(cur.time.slice(0, 13)));
  const next6 = data.hourly.precipitation_probability.slice(nowIdx, nowIdx + 6);
  
  const ageMinutes = Math.floor((Date.now() - new Date(cur.time + "+05:30").getTime()) / 60000);

  return normalizeAndValidate({
    temp: cur.temperature_2m, humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m,
    precipNow: cur.precipitation > 0, chanceOfRain: calculateWindowRainProbability(next6),
    validTime: cur.time, ageMinutes: Math.max(0, ageMinutes),
  }, "Open-Meteo GFS");
}

async function getWeatherAPI(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const key = process.env.WEATHERAPI_KEY;
  if (!key) throw new Error("Missing WEATHERAPI_KEY");
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${key}&q=${lat},${lon}&days=1&aqi=yes`;
  const data = await fetchWithTimeout(url);
  const cur = data.current;
  
  const hourlyProbs = data.forecast.forecastday[0].hour
    .slice(new Date().getHours(), new Date().getHours() + 6)
    .map(h => h.chance_of_rain);
    
  const ageMinutes = Math.floor((Date.now() - new Date(cur.last_updated).getTime()) / 60000);

  return normalizeAndValidate({
    temp: cur.temp_c, humidity: cur.humidity, wind: cur.wind_kph,
    precipNow: cur.precip_mm > 0, chanceOfRain: calculateWindowRainProbability(hourlyProbs),
    uv: cur.uv, feelsLike: cur.feelslike_c, airQuality: cur.air_quality ? cur.air_quality.pm2_5 : null,
    validTime: cur.last_updated, ageMinutes: Math.max(0, ageMinutes),
  }, "WeatherAPI");
}

async function getTomorrow(lat = DEFAULT_LAT, lon = DEFAULT_LON) {
  const key = process.env.TOMORROW_KEY;
  if (!key) throw new Error("Missing TOMORROW_KEY");
  const url = `https://api.tomorrow.io/v4/weather/realtime?location=${lat},${lon}&units=metric`;
  const data = await fetchWithTimeout(url, { headers: { "apikey": key, "Accept": "application/json" } });
  const v = data.data.values;
  
  const ageMinutes = Math.floor((Date.now() - new Date(data.data.time).getTime()) / 60000);

  return normalizeAndValidate({
    temp: v.temperature, humidity: v.humidity, wind: v.windSpeed * 3.6, 
    precipNow: v.precipitationIntensity > 0, chanceOfRain: v.precipitationProbability,
    uv: v.uvIndex, feelsLike: v.temperatureApparent,
    validTime: data.data.time, ageMinutes: Math.max(0, ageMinutes),
  }, "Tomorrow.io");
}

// ─── Backend Reconciliation Engine ───────────────────────────────────────────
function reconcile(results) {
  const good = results.filter(r => r.status === "ok").map(r => r.data);
  const failed = results.filter(r => r.status === "error").map(r => r.source);

  if (good.length === 0) {
    console.warn("\n! CRITICAL WARNING: All weather sources failed.");
    return { city: "Hyderabad", stale: true, sourcesFailed: failed, sourcesUsed: [], generatedAt: new Date().toISOString() };
  }

  const avgTemp = calculateMedian(good.map(d => d.temp));
  const avgHumidity = calculateMedian(good.map(d => d.humidity));
  const avgWind = calculateMedian(good.map(d => d.wind));
  const rainChance = calculateMedian(good.map(d => d.chanceOfRain));

  const temps = good.map(d => d.temp);
  const tempSpread = calculateSpread(temps);
  
  const anyPrecipNow = good.some(d => d.precipNow);
  const rainProbs = good.map(d => d.chanceOfRain);
  let { agreement, confLevel } = calculateRainConfidence(rainProbs, anyPrecipNow);

  if (tempSpread >= 3) confLevel = "low";

  const isDay = good.find(d => d.isDay !== undefined)?.isDay ?? true;
  const high = good.find(d => d.high != null)?.high ?? null;
  const low = good.find(d => d.low != null)?.low ?? null;
  const uv = good.find(d => d.uv != null)?.uv ?? null;
  const feelsLike = good.find(d => d.feelsLike != null)?.feelsLike ?? null;
  const airQuality = good.find(d => d.airQuality != null)?.airQuality ?? null;

  let condition = "cloudy";
  if (agreement === "all_wet" || agreement === "mostly_wet") condition = "rainy";
  else if (agreement === "all_dry") condition = "clear";

  const sourcesMeta = {};
  good.forEach(d => {
    sourcesMeta[d.source] = { validTime: d.validTime, ageMinutes: d.ageMinutes };
  });

  return {
    city: "Hyderabad",
    temp: avgTemp,
    humidity: avgHumidity,
    wind: avgWind,
    chanceOfRain: rainChance,
    condition,
    isDay,
    high,
    low,
    confidence: confLevel,
    rainAgreement: agreement,
    tempSpread,
    uv,
    feelsLike,
    airQuality,
    sourcesUsed: good.map(d => d.source),
    sourcesFailed: failed,
    sourcesMeta,
    stale: false,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Main Execution ─────────────────────────────────────────────────────────
async function main() {
  console.log("Fetching weather data across multi-model cluster...\n");

  const results = await Promise.all([
    getOpenMeteoICON().then(d => ({ status: "ok", source: "Open-Meteo ICON", data: d })).catch(e => ({ status: "error", source: "Open-Meteo ICON", error: e.message })),
    getOpenMeteoECMWF().then(d => ({ status: "ok", source: "Open-Meteo ECMWF", data: d })).catch(e => ({ status: "error", source: "Open-Meteo ECMWF", error: e.message })),
    getOpenMeteoGFS().then(d => ({ status: "ok", source: "Open-Meteo GFS", data: d })).catch(e => ({ status: "error", source: "Open-Meteo GFS", error: e.message })),
    getWeatherAPI().then(d => ({ status: "ok", source: "WeatherAPI", data: d })).catch(e => ({ status: "error", source: "WeatherAPI", error: e.message })),
    getTomorrow().then(d => ({ status: "ok", source: "Tomorrow.io", data: d })).catch(e => ({ status: "error", source: "Tomorrow.io", error: e.message })),
  ]);

  results.forEach(r => {
    if (r.status === "ok") console.log(`✓ ${r.source}: ${r.data.temp}°C, ${r.data.chanceOfRain}% rain (${r.data.ageMinutes} mins old)`);
    else console.log(`✗ ${r.source}: FAILED — ${r.error}`);
  });

  const reconciled = reconcile(results);
  console.log("\n--- Reconciled Weather Payload ---");
  console.log(JSON.stringify(reconciled, null, 2));

  writeFileSync("weather.json", JSON.stringify(reconciled, null, 2));
  console.log("\n✓ weather.json updated successfully");
}

main();