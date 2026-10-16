#!/usr/bin/env node
// Controlled visual correctness comparison, not a timing benchmark.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto')
const root=path.resolve(__dirname,'../..'),directory=path.join(root,'docs/verification/rendering-performance')
const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name)))
const baseline=read('night-lighting-baseline.json'),after=read('night-lighting-after.json')
const gridBaseline=read('night-lighting-grid-baseline.json'),grid=read('night-lighting-grid-after.json')
const probes=read('cloud-irradiance-night.json')
const sdkPath=path.join(root,'build/0.1.0/CCR.min.js')
const sdkSha256=createHash('sha256').update(fs.readFileSync(sdkPath)).digest('hex')
for(const report of [baseline,after,gridBaseline,grid]){
  assert.equal(report.sdkSha256,sdkSha256,'captures must use the same final SDK')
  assert.equal(report.errors.length,0)
}
assert.equal(baseline.nightDisabled,true)
assert.equal(after.nightDisabled,false)
assert.equal(after.cases.length,12)
const comparisons=after.cases.map(row=>{
  const original=baseline.cases.find(x=>x.time===row.time&&x.view===row.view)
  assert.ok(original)
  assert.equal(row.glError,0)
  assert.ok(row.cloudDepthError<=1e-5)
  const day=row.time.endsWith('11:00')
  const delta=Math.abs(row.records['environment.composite'].meanL-original.records['environment.composite'].meanL)
  if(day){
    assert.equal(row.night.nightWeight,0)
    assert.ok(delta<1e-4,'daytime output regressed')
  }else{
    assert.ok(row.display.visibleRatio>.2)
    assert.ok(row.display.rgb[2]>row.display.rgb[0])
    if(row.view==='clouds')assert.ok(row.records['cloud.march'].meanL>1e-4)
    if(row.night.moonHeight<0)assert.ok(row.night.moonRadiance.every(v=>v===0))
  }
  return {time:row.time,view:row.view,day,baselineMean:original.records['environment.composite'].meanL,
    afterMean:row.records['environment.composite'].meanL,delta,displayRgb:row.display.rgb,
    cloudRgb:row.records['cloud.march']?.cloudRgb,moonPhase:row.night.moonPhase,moonHeight:row.night.moonHeight,
    lunarDisc:row.records.nativeMoon,skyPeakFeatures:row.display.skyPeaks}
})
const full=after.cases.find(x=>x.time.startsWith('2026-09-26')&&x.view==='sky')
const quarter=after.cases.find(x=>x.time.startsWith('2026-09-18')&&x.view==='sky')
const moonless=after.cases.find(x=>x.time.startsWith('2026-09-10')&&x.view==='sky')
assert.ok(full.records.nativeMoon.peak>.04&&full.records.nativeMoon.litPixels>quarter.records.nativeMoon.litPixels)
assert.ok(quarter.records.nativeMoon.litPixels>=3)
assert.ok(moonless.display.skyPeaks>=10)
assert.equal(gridBaseline.cases[0].records.nativeSky.meanL,0)
assert.ok(grid.cases[0].records.nativeSky.meanL>1e-5&&grid.cases[0].night.globeNight.draws>0)
assert.equal(probes.samples.length,20);assert.equal(probes.lunar.length,9)
const summary={sdkSha256,sdkBytes:fs.statSync(sdkPath).size,comparison:'same SDK; night sources and native adapters disabled versus active',
  comparisons,maxDayMeanDelta:Math.max(...comparisons.filter(x=>x.day).map(x=>x.delta)),
  grid:{baselineNativeMean:gridBaseline.cases[0].records.nativeSky.meanL,afterNativeMean:grid.cases[0].records.nativeSky.meanL,
    nativeSamples:grid.cases[0].records.nativeSky.center,globeAdapter:grid.cases[0].night.globeNight},
  gpu:{solarCases:probes.samples.length,lunarCases:probes.lunar.length},
  limitations:['Engineering HDR night intensities, not calibrated photometry.','Moon phase uses geocentric Lambert approximation; light direction includes observer parallax.',
    'Native Moon/Globe shader adapters target Cesium 1.143.','No timing or VRAM benchmark. Sky peak features are not catalog star counts.']}
fs.writeFileSync(path.join(directory,'night-lighting-summary.json'),JSON.stringify(summary,null,2))
console.log(JSON.stringify({sdkSha256,maxDayMeanDelta:summary.maxDayMeanDelta,grid:summary.grid,gpu:summary.gpu},null,2))
