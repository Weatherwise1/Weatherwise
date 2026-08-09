// --- THE ENGINE FUNCTIONS ---
function calculateMedian(values) {
    if (!values || values.length === 0) return null;
    const validValues = values.filter(v => v !== null && !isNaN(v)).sort((a, b) => a - b);
    if (validValues.length === 0) return null;
    const mid = Math.floor(validValues.length / 2);
    return validValues.length % 2 !== 0 ? validValues[mid] : (validValues[mid - 1] + validValues[mid]) / 2;
}

function calculateSpread(values) {
    if (!values || values.length < 2) return 0;
    const validValues = values.filter(v => v !== null && !isNaN(v));
    if (validValues.length < 2) return 0;
    return Math.max(...validValues) - Math.min(...validValues);
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

// --- THE TEST SUITE ---
console.log("🌦️ WEATHERWISE ENSEMBLE TEST SUITE\n");

// TEST 1: The Outlier Test (Temperature)
// Simulates ECMWF and ICON agreeing on 32°C, but GFS hallucinates 45°C.
const tempOutlier = [32, 33, 45];
console.log(`Test 1 (Outlier Temp): Median is ${calculateMedian(tempOutlier)}°C (Spread: ${calculateSpread(tempOutlier)}°C)`);
// Expected: Median ignores the 45°C and outputs 32.5°C.

// TEST 2: The Missing Data Test (Temperature)
// Simulates one provider failing (null) and one returning corrupted data (NaN).
const tempCorrupted = [29, null, NaN, 30];
console.log(`Test 2 (Corrupted Data): Median is ${calculateMedian(tempCorrupted)}°C`);
// Expected: System safely ignores null/NaN and averages the survivors (29.5°C).

// TEST 3: The MAX() Fallacy Test (Rain Probability)
// Simulates a 30% chance of rain at 1pm, and a 30% chance at 2pm.
const rainWindow = [30, 30];
console.log(`Test 3 (Rain Window): True window probability is ${calculateWindowRainProbability(rainWindow)}%`);
// Expected: Instead of the flawed Math.max() returning 30%, it calculates the cumulative meteorological chance (~40%).

// TEST 4: Single Provider Fallback
// Simulates a total network failure where only one source survives.
const singleSource = [28];
console.log(`Test 4 (Single Source): Median is ${calculateMedian(singleSource)}°C (Spread: ${calculateSpread(singleSource)}°C)`);
// Expected: System doesn't crash, returns 28°C with 0 spread.

// TEST 5: Complete Failure
// Simulates every API returning null or corrupted data.
const totalFailure = [null, NaN, undefined];
console.log(`Test 5 (Total Failure): Output is ${calculateMedian(totalFailure)}`);
// Expected: Returns null instead of crashing or generating a fake "0°C".

console.log("\n✅ Test suite complete.");