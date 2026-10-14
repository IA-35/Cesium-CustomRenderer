import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { PLANET_RADIUS_M, ATMOSPHERE_RADIUS_M } from '../../src/environment/atmosphereScattering143.js'

const C = createRequire(import.meta.url)('cesium/Build/Cesium/index.cjs')

// The atmosphere integral is written for a planet-centred frame: it intersects a sphere at the
// origin and derives altitude as length(position) - planetRadius. EnvironmentRenderer instead
// hands it an ENU frame whose origin sits on the ellipsoid, so the same expression measures the
// distance from the planet centre to a point near the surface.
//
// Measured result: at the campus latitude the error is about -2.2 km, and at the equator about
// +7.2 km. Both are far larger than the 100 m the camera actually sits at, which is why the
// mismatch is fatal rather than a small bias.

const campus = C.Cartesian3.fromDegrees(123.410315, 41.761969, 0)

test('ENU origin is a point on the ellipsoid, so length(p) - planetRadius is not an altitude', () => {
  const cameraHeightAboveSurface = 100
  const cameraEcef = C.Cartesian3.fromDegrees(123.410315, 41.761969, cameraHeightAboveSurface)
  // What the shader computes when it is given a planet-centred position:
  const planetCentredAltitude = C.Cartesian3.magnitude(cameraEcef) - PLANET_RADIUS_M
  // What it computes when it is given an ENU position instead (origin at the ellipsoid surface,
  // which is what eyeToLocal produces):
  const enuOriginMagnitude = C.Cartesian3.magnitude(campus)
  const enuMisreadAltitude = enuOriginMagnitude - PLANET_RADIUS_M + cameraHeightAboveSurface

  assert.ok(Math.abs(planetCentredAltitude - cameraHeightAboveSurface) > 1000,
    'the sphere radius is not the local ellipsoid radius, so even a correct frame carries a bias')
  assert.ok(Math.abs(enuMisreadAltitude - cameraHeightAboveSurface) > 1000,
    'reading the ENU origin as a planet-centred position also carries a large error')
  console.log(`true height ${cameraHeightAboveSurface} m | planet-centred read ${planetCentredAltitude.toFixed(1)} m`
    + ` | ENU misread ${enuMisreadAltitude.toFixed(1)} m | ellipsoid-vs-sphere at origin ${enuOriginMagnitude - PLANET_RADIUS_M === 0 ? 0 : (enuOriginMagnitude - PLANET_RADIUS_M).toFixed(1)} m`)
})

test('the ellipsoid-vs-sphere difference depends on latitude, so no single constant fixes it', () => {
  // Same 100 m height at the equator and at the pole, compared against the mean sphere radius.
  const equator = C.Cartesian3.magnitude(C.Cartesian3.fromDegrees(0, 0, 100)) - PLANET_RADIUS_M
  const pole = C.Cartesian3.magnitude(C.Cartesian3.fromDegrees(0, 90, 100)) - PLANET_RADIUS_M
  assert.ok(Math.abs(equator - pole) > 10000,
    'the difference must be latitude dependent, which rules out a fixed correction offset')
  console.log(`mean-sphere read at equator ${equator.toFixed(1)} m, at pole ${pole.toFixed(1)} m`)
})

test('the error is a fraction of the shell, so the damage is ray length and not an overflow', () => {
  const shell = ATMOSPHERE_RADIUS_M - PLANET_RADIUS_M
  assert.equal(shell, 100000)
  const equatorError = Math.abs(C.Cartesian3.magnitude(C.Cartesian3.fromDegrees(0, 0, 100)) - PLANET_RADIUS_M)
  const campusError = Math.abs(C.Cartesian3.magnitude(C.Cartesian3.fromDegrees(123.410315, 41.761969, 100)) - PLANET_RADIUS_M)
  // Measured: about 7237 m at the equator and 2205 m at the campus latitude. Both are a few
  // percent of the 100 km shell rather than many multiples of it, so the failure mode is a wrong
  // ray length and a wrong medium integral, not a density overflow. Recorded explicitly because
  // the earlier review described it as "exponential explosion", which the numbers do not support.
  assert.ok(equatorError < shell, `equator error ${equatorError.toFixed(0)} m exceeds one shell thickness`)
  assert.ok(campusError < shell, `campus error ${campusError.toFixed(0)} m exceeds one shell thickness`)
  assert.ok(equatorError / shell < 0.1, 'the error stays well under a shell thickness')
  console.log(`shell ${shell} m | equator error ${equatorError.toFixed(0)} m (${(equatorError / shell * 100).toFixed(1)}%)`
    + ` | campus error ${campusError.toFixed(0)} m (${(campusError / shell * 100).toFixed(1)}%)`)
})
