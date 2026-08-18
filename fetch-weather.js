import fs from 'fs';

const LAT = 17.3850;
const LON = 78.4867;
const CITY = "Hyderabad";

// API Keys from GitHub Actions Environment Variables
const WEATHERAPI_KEY = process.env.WEATHERAPI_KEY;
const TOMORROW_KEY = process.env.TOMORROW_KEY;

// =============== MATH HELPERS ===============
function getMedian(values) {
    const valid = values.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
    if (valid.length === 0) return null;
    const mid = Math.floor(valid.length / 2);
    return valid.length % 2 !== 0 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function getMean(values) {
    const valid = values.filter(v => v !== null && !isNaN(v));
    if (valid.length === 0) return null;
    return Number((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(1));
}

function getPercentile(values, p) {
    const valid = values.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
    if (valid.length === 0) return null;
    const index = (p / 100) * (valid.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (upper >= valid.length) return valid[lower];
    return Number((valid[lower] * (1 - weight) + valid[upper] * weight).toFixed(1));
}

function calculateSpread(values) {
    const valid = values.filter(v => v !== null && !isNaN(v));
    if (valid.length < 2) return 0;
    return Math.round((Math.max(...valid) - Math.min(...valid)) * 10) / 10;
}

function getAgeMinutes(timestamp) {
    if (!timestamp) return 0;
    return Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60000));
}

// =============== FETCHERS ===============
async function fetchOpenMeteoModel(modelName) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,weather_code,is_day,surface_pressure&daily=temperature_2m_max,temperature_2m_min,uv_index_max&models=${modelName}&timezone=Asia%2FKolkata`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${modelName} fetch failed`);
    const data = await res.json();
    return {
        name: `Open-Meteo ${modelName.split('_')[0].toUpperCase()}`,
        type: "model",
        temp: data.current.temperature_2m,
        humidity: data.current.relative_humidity_2m,
        wind: data.current.wind_speed_10m,
        isRaining: data.current.precipitation >= 0.2 && data.current.weather_code >= 50,
        high: data.daily.temperature_2m_max[0],
        low: data.daily.temperature_2m_min[0],
        uv: data.daily.uv_index_max[0],
        isDay: data.current.is_day === 1,
        validTime: data.current.time
    };
}

async function fetchWeatherAPI() {
    if (!WEATHERAPI_KEY) throw new Error("No API Key");
    const url = `https://api.weatherapi.com/v1/current.json?q=${LAT},${LON}&key=${WEATHERAPI_KEY}&aqi=yes`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("WeatherAPI fetch failed");
    const data = await res.json();
    return {
        name: "WeatherAPI",
        type: "hardware",
        temp: data.current.temp_c,
        humidity: data.current.humidity,
        wind: data.current.wind_kph,
        isRaining: data.current.precip_mm >= 0.2,
        feelsLike: data.current.feelslike_c,
        uv: data.current.uv,
        airQuality: data.current.air_quality["us-epa-index"] || null,
        isDay: data.current.is_day === 1,
        validTime: data.current.last_updated
    };
}

async function fetchTomorrowIO() {
    if (!TOMORROW_KEY) throw new Error("No API Key");
    const url = `https://api.tomorrow.io/v4/weather/realtime?location=${LAT},${LON}&apikey=${TOMORROW_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Tomorrow.io fetch failed");
    const data = await res.json();
    return {
        name: "Tomorrow.io",
        type: "hardware",
        temp: data.data.values.temperature,
        humidity: data.data.values.humidity,
        wind: data.data.values.windSpeed * 3.6, // m/s to kph
        isRaining: data.data.values.rainIntensity >= 0.2,
        feelsLike: data.data.values.temperatureApparent,
        uv: data.data.values.uvIndex,
        isDay: null, // Tomorrow.io realtime doesn't reliably give is_day
        validTime: data.data.time
    };
}

// =============== MAIN ORCHESTRATOR ===============
async function generateWeatherData() {
    const sourcesUsed = [];
    const sourcesFailed = [];
    const sourcesMeta = {};
    const results = [];

    // 1. Wrap fetchers in safe functions to prevent Unhandled Promise Rejections
    const fetchers = [
        { func: () => fetchOpenMeteoModel("icon_seamless"), name: "Open-Meteo ICON" },
        { func: () => fetchOpenMeteoModel("ecmwf_ifs025"), name: "Open-Meteo ECMWF" },
        { func: () => fetchOpenMeteoModel("gfs_seamless"), name: "Open-Meteo GFS" },
        { func: () => fetchWeatherAPI(), name: "WeatherAPI" },
        { func: () => fetchTomorrowIO(), name: "Tomorrow.io" }
    ];

    // 2. Fire all API requests concurrently and safely catch any errors
    const fetchPromises = fetchers.map(async (f) => {
        try {
            const data = await f.func();
            results.push(data);
            sourcesUsed.push(data.name);
            sourcesMeta[data.name] = {
                type: data.type,
                validTime: data.validTime,
                ageMinutes: getAgeMinutes(data.validTime)
            };
        } catch (error) {
            sourcesFailed.push(f.name);
            console.error(`[${f.name}] Failed:`, error.message);
        }
    });

    await Promise.all(fetchPromises);

    if (results.length === 0) {
        console.error("CRITICAL: All weather APIs failed.");
        process.exit(1);
    }

    // 3. Hardware vs Model Logic
    const hardware = results.filter(r => r.type === "hardware");
    const models = results.filter(r => r.type === "model");

    const allTemps = results.map(r => r.temp);
    const p10 = getPercentile(allTemps, 10);
    const p90 = getPercentile(allTemps, 90);
    const rainCount = results.filter(r => r.isRaining).length;

    // Prioritize hardware observations for current conditions
    const primary = hardware.length > 0 ? hardware[0] : models[0];

    // Safe bounds checking if models fail
    const high = models.length > 0 ? Math.max(...models.map(m => m.high).filter(v => v !== undefined)) : null;
    const low = models.length > 0 ? Math.min(...models.map(m => m.low).filter(v => v !== undefined)) : null;

    const payload = {
        city: CITY,
        observationType: primary.type,
        temp: Math.round(primary.temp),
        expectedTempRange: {
            min: Math.round(p10),
            max: Math.round(p90)
        },
        ensembleMetrics: {
            tempMean: getMean(allTemps),
            tempMedian: getMedian(allTemps),
            tempSpread: calculateSpread(allTemps),
            tempP10: p10,
            tempP25: getPercentile(allTemps, 25),
            tempP75: getPercentile(allTemps, 75),
            tempP90: p90
        },
        humidity: Math.round(getMedian(results.map(r => r.humidity))),
        wind: Math.round(getMedian(results.map(r => r.wind))),
        chanceOfRain: Math.round((rainCount / results.length) * 100),
        condition: primary.isRaining ? "rainy" : "cloudy", 
        isDay: primary.isDay !== null ? primary.isDay : true,
        high: high,
        low: low,
        confidence: results.length >= 3 && calculateSpread(allTemps) <= 2 ? "high" : "medium",
        rainAgreement: rainCount === results.length ? "all_wet" : rainCount === 0 ? "all_dry" : rainCount > results.length / 2 ? "mostly_wet" : "split",
        uv: Math.round(getMedian(results.map(r => r.uv))),
        feelsLike: Math.round(primary.feelsLike || primary.temp),
        airQuality: hardware.find(h => h.airQuality !== null)?.airQuality || null,
        sourcesUsed,
        sourcesFailed,
        sourcesMeta,
        stale: false,
        generatedAt: new Date().toISOString()
    };

    // 4. Write Main Weather File
    fs.writeFileSync('./weather.json', JSON.stringify(payload, null, 2));
    console.log("✅ weather.json updated successfully.");

    // 5. Update History Ledger
    updateHistory(payload);
}

function updateHistory(payload) {
    let history = [];
    if (fs.existsSync('./history.json')) {
        try { history = JSON.parse(fs.readFileSync('./history.json', 'utf8')); } 
        catch (e) { console.error("Error reading history.json, resetting."); }
    }

    const todayDate = new Date().toISOString().split('T')[0];
    
    // Prevent duplicate entries for the exact same day
    if (!history.find(h => h.date === todayDate)) {
        history.push({
            date: todayDate,
            expectedTempRange: payload.expectedTempRange,
            observedTemp: payload.temp
        });
        
        // Keep ledger light (last 14 days)
        if (history.length > 14) history.shift();
        
        fs.writeFileSync('./history.json', JSON.stringify(history, null, 2));
        console.log("✅ history.json updated successfully.");
    }
}

// Execute
generateWeatherData();