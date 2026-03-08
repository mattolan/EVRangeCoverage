// Temperature-based range degradation

/**
 * Calculate the range factor based on temperature.
 * Linear model: 100% at 20C+, decreasing 1% per degree below 20C.
 * Clamped at 40% minimum (at -40C).
 * @param {number} tempC - Temperature in Celsius
 * @returns {number} Factor between 0.40 and 1.0
 */
export function getRangeFactor(tempC) {
  if (tempC >= 20) return 1.0;
  const factor = 1.0 - (20 - tempC) * 0.01;
  return Math.max(0.40, factor);
}

/**
 * Calculate adjusted range given base range and temperature.
 * @param {number} baseRangeKm - Vehicle's rated range in km
 * @param {number} tempC - Temperature in Celsius
 * @returns {number} Adjusted range in km
 */
export function getAdjustedRange(baseRangeKm, tempC) {
  return baseRangeKm * getRangeFactor(tempC);
}
