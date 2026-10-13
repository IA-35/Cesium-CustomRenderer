#!/usr/bin/env node
/**
 * 把 Web Mercator (EPSG:3857) 的水面 GeoJSON 转为 CCR 水面集合所需的 WGS84 资产。
 *
 * 与同目录 prepare-water-polygons.cjs 的区别：
 *   - 那个脚本处理的是 EPSG:4550（CGCS2000 高斯投影），用 proj4 转换；
 *   - 本脚本处理 EPSG:3857（Web 墨卡托），用 turf.toWgs84，
 *     与项目内 src/views/IAsCesiumLib/lib/vegetationGeoJson.js 的做法一致。
 * 两者不可混用：把 3857 的坐标喂给 4550 的转换会得到错误位置。
 *
 * 输出结构必须满足 WaterSurfaceCollection._validate：
 *   schemaVersion===1、targetCrs==='EPSG:4326'、每个 feature 有 id、
 *   geometry.type==='Polygon'、环闭合、且有有限的 properties.height。
 *
 * 用法：
 *   node prepare-water-mercator.cjs --input <源 3857 GeoJSON> --output <目标路径> [--heights 0.6,0.85]
 */
const fs = require('node:fs')
const path = require('node:path')
const turf = require('@turf/turf')

const TARGET_CRS = 'EPSG:4326'
const SOURCE_CRS = 'EPSG:3857'

/** 环是否闭合（首尾点相同）。 */
function isClosedRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first[0] === last[0] && first[1] === last[1]
}

/** 确保环闭合；未闭合时补上首点。 */
function closeRing(ring) {
  if (isClosedRing(ring)) return ring
  return [...ring, [...ring[0]]]
}

/**
 * 校验转换结果落在合理经纬度范围内，并位于预期校区附近。
 * 这是防止"坐标系判断错误"的关键闸门：若把 4550 数据当 3857 处理，
 * 结果会飞到地球另一处，此处会直接报错而不是静默生成坏资产。
 */
function assertReasonableWgs84(features, expectedCenter, toleranceMetres) {
  const collection = turf.featureCollection(features.map(f => turf.polygon(f.geometry.coordinates)))
  const bounds = turf.bbox(collection)
  const [minLon, minLat, maxLon, maxLat] = bounds
  for (const [lon, lat] of [[minLon, minLat], [maxLon, maxLat]]) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('转换结果含非有限坐标')
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new Error(`转换结果超出经纬度范围：lon=${lon} lat=${lat}（坐标系判定可能有误）`)
    }
  }
  const center = [(minLon + maxLon) / 2, (minLat + maxLat) / 2]
  const distance = turf.distance(turf.point(center), turf.point(expectedCenter), { units: 'meters' })
  if (distance > toleranceMetres) {
    throw new Error(
      `转换后中心 (${center.map(v => v.toFixed(7)).join(', ')}) 距预期位置 ${distance.toFixed(0)}m，`
      + `超过容差 ${toleranceMetres}m（坐标系可能不是 ${SOURCE_CRS}）`
    )
  }
  return { bounds, center, distance }
}

function prepareWaterPolygons(options) {
  const { input, output, heights, expectedCenter = [123.410315, 41.761969], toleranceMetres = 5000 } = options
  const source = JSON.parse(fs.readFileSync(input, 'utf8'))
  if (source.type !== 'FeatureCollection' || !Array.isArray(source.features)) {
    throw new Error('水面源数据必须是 GeoJSON FeatureCollection')
  }
  if (!source.features.length) throw new Error('水面源数据没有任何 feature')

  // 整份 GeoJSON 一次性转 WGS84，避免逐点转换时坐标顺序写错。
  const converted = turf.toWgs84(source)

  let areaSquareMetres = 0
  let pointCount = 0
  const features = converted.features.map((feature, index) => {
    if (feature.geometry?.type !== 'Polygon') {
      throw new Error(`水面 feature[${index}] 不是 Polygon`)
    }
    // 逐环闭合，并去掉高程分量（WaterSurfaceCollection 用 properties.height 统一给高度）。
    const rings = feature.geometry.coordinates.map(ring => {
      const planar = closeRing(ring.map(point => [Number(point[0]), Number(point[1])]))
      if (planar.length < 4) throw new Error(`水面 feature[${index}] 环点数不足：${planar.length}`)
      if (!planar.every(point => point.every(Number.isFinite))) {
        throw new Error(`水面 feature[${index}] 含非有限坐标`)
      }
      return planar
    })
    const height = heights[index]
    if (!Number.isFinite(height)) throw new Error(`水面 feature[${index}] 没有配置高度`)

    const polygon = turf.polygon(rings)
    const area = turf.area(polygon)
    areaSquareMetres += area
    pointCount += rings.reduce((sum, ring) => sum + ring.length, 0)

    return {
      id: `water-${index + 1}`,
      geometry: { type: 'Polygon', coordinates: rings },
      properties: {
        // 保留源数据的 OBJECTID 便于追溯。
        objectId: feature.properties?.OBJECTID ?? index + 1,
        height
      }
    }
  })

  const audit = assertReasonableWgs84(features, expectedCenter, toleranceMetres)

  const prepared = {
    schemaVersion: 1,
    source: path.basename(input),
    sourceCrs: SOURCE_CRS,
    targetCrs: TARGET_CRS,
    summary: {
      featureCount: features.length,
      pointCount,
      areaSquareMetres: Number(areaSquareMetres.toFixed(3)),
      bounds: audit.bounds.map(value => Number(value.toFixed(7))),
      centromDistanceToCampusMetres: Number(audit.distance.toFixed(1))
    },
    features
  }

  if (output) {
    const outputPath = path.resolve(output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, `${JSON.stringify(prepared, null, 2)}\n`)
  }
  return prepared
}

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    if (!key || argv[index + 1] === undefined) throw new Error(`缺少 ${argv[index] || '参数'} 的值`)
    result[key] = argv[index + 1]
  }
  return result
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2))
    // 高度按顺序对应每个 feature；默认沿用现有水面资产的值。
    const heights = options.heights
      ? options.heights.split(',').map(Number)
      : [0.6, 0.85]
    const prepared = prepareWaterPolygons({
      input: options.input,
      output: options.output,
      heights,
      expectedCenter: options.center ? options.center.split(',').map(Number) : undefined
    })
    console.log(JSON.stringify(prepared.summary, null, 2))
  } catch (error) {
    console.error(error.stack || error.message)
    process.exitCode = 1
  }
}

module.exports = { prepareWaterPolygons, isClosedRing, closeRing, assertReasonableWgs84 }
