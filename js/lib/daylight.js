/**
 * Sunrise / sunset for a given date and position.
 *
 * Standard low-precision solar position maths (the same approach SunCalc
 * uses) -- accurate to well under a minute, which is far more than a theme
 * switch needs. Pure arithmetic: no network, no API key, works in a tunnel.
 *
 * Why not just use a fixed hour like "dark after 7pm"? Because that is wrong
 * for most of the year. In late June sunset is near 9pm; in December it is
 * closer to 4:30pm. A fixed cutoff would leave the screen glaring in the dark
 * for hours in winter -- which is the exact problem this is meant to solve.
 */

var rad = Math.PI / 180;
var dayMs = 86400000;
var J1970 = 2440588;
var J2000 = 2451545;
var obliquity = rad * 23.4397;

// Standard refraction-corrected altitude of the sun's centre at sunrise/set.
var SUN_ALTITUDE = rad * -0.833;

function toJulian(date) { return date.valueOf() / dayMs - 0.5 + J1970; }
function fromJulian(j) { return new Date((j + 0.5 - J1970) * dayMs); }
function toDays(date) { return toJulian(date) - J2000; }

function solarMeanAnomaly(d) { return rad * (357.5291 + 0.98560028 * d); }

function eclipticLongitude(M) {
  // Equation of centre plus perihelion of the earth.
  var C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  var P = rad * 102.9372;
  return M + C + P + Math.PI;
}

function declination(L) { return Math.asin(Math.sin(obliquity) * Math.sin(L)); }

function julianCycle(d, lw) { return Math.round(d - 0.0009 - lw / (2 * Math.PI)); }
function approxTransit(Ht, lw, n) { return 0.0009 + (Ht + lw) / (2 * Math.PI) + n; }
function solarTransitJ(ds, M, L) {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

function hourAngle(h, phi, d) {
  return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) /
                   (Math.cos(phi) * Math.cos(d)));
}

/**
 * @returns {{sunrise: Date, sunset: Date}|null}
 *   null above the polar circles on days with no sunrise or sunset at all,
 *   where the maths has no solution.
 */
export function sunTimes(date, lat, lng) {
  var lw = rad * -lng;
  var phi = rad * lat;
  var d = toDays(date);

  var n = julianCycle(d, lw);
  var ds = approxTransit(0, lw, n);
  var M = solarMeanAnomaly(ds);
  var L = eclipticLongitude(M);
  var dec = declination(L);

  var Jnoon = solarTransitJ(ds, M, L);
  var w = hourAngle(SUN_ALTITUDE, phi, dec);

  // Polar day or polar night: the sun never crosses the horizon.
  if (isNaN(w)) return null;

  var Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
  var Jrise = Jnoon - (Jset - Jnoon);

  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
}

/**
 * Is it daylight right now at this position?
 * @returns {boolean|null} null when it cannot be determined.
 */
export function isDaylightAt(date, lat, lng) {
  var t = sunTimes(date, lat, lng);
  if (!t) {
    // Polar region: fall back to solar declination vs latitude to decide
    // whether this is the midnight-sun half of the year or the dark half.
    var dec = declination(eclipticLongitude(solarMeanAnomaly(toDays(date))));
    return (lat >= 0) === (dec > 0);
  }
  var now = date.valueOf();
  return now > t.sunrise.valueOf() && now < t.sunset.valueOf();
}

/**
 * Crude clock-based guess, used only when there is no position at all.
 * Deliberately conservative: it errs toward dark, since a too-dark screen in
 * daylight is merely dim, while a too-bright one at night is dazzling.
 */
export function isDaylightByClock(date) {
  var h = date.getHours();
  return h >= 8 && h < 18;
}
