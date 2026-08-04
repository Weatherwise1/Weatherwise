import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

// Hyderabad's coordinates
const LAT = 17.385;
const LON = 78.4867;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_KEY });

async function getOpenMeteo() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,precipitation,weather_code&hourly=precipitation_probability&timezone=Asia%2FKolkata`;
  const res = await fetch(url);
  return res.json();
}

async function getWeatherApi() {
  const key = process.env.WEATHERAPI_KEY;
  const url = `https://api.weatherapi.com/v1/forecast.json?key=${key}&q=Hyderabad&days=1&aqi=no&alerts=no`;
  const res = await fetch(url);
  return res.json();
}

function reconcile(openMeteo, weatherApi) {
  const omTemp = openMeteo.current.temperature_2m;
  const waTemp = weatherApi.current.temp_c;
  const omRainingNow = openMeteo.current.precipitation > 0;
  const waChanceOfRain = weatherApi.current.chance_of_rain;
  const waCondition = weatherApi.current.condition.text;

  const avgTemp = Math.round(((omTemp + waTemp) / 2) * 10) / 10;
  const tempDiff = Math.round(Math.abs(omTemp - waTemp) * 10) / 10;

  const wetSignal = omRainingNow || waChanceOfRain > 40;
  const drySignal = !omRainingNow && waChanceOfRain < 20;
  const agreement = wetSignal || drySignal ? "agree" : "mixed";

  return {
    city: "Hyderabad",
    avgTemp,
    tempDiff,
    condition: waCondition,
    chanceOfRain: waChanceOfRain,
    agreement,
    raw: { openMeteo: omTemp, weatherApi: waTemp },
  };
}

async function generateSummary(data) {
  const prompt = `You are a weather translator for people who don't understand meteorology.
Write ONE short, plain funny-English sentence (max 30 words) describing this weather for Hyderabad.
Be direct and practical — mention if they need an umbrella, if it's hot, etc.
If "agreement" is "mixed", add a brief honest note that forecasts are uncertain right now.

Data: ${JSON.stringify(data)}

Respond with ONLY the sentence, no quotes, no extra text.`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: prompt,
  });

  return response.text.trim();
}

async function main() {
  const [openMeteo, weatherApi] = await Promise.all([
    getOpenMeteo(),
    getWeatherApi(),
  ]);

  const result = reconcile(openMeteo, weatherApi);
  console.log("\n--- Reconciled Result ---");
  console.log(JSON.stringify(result, null, 2));

  console.log("\n--- AI Summary ---");
  const summary = await generateSummary(result);
  console.log(summary);
}

main();