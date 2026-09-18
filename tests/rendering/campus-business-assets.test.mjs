import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import {parse} from '@babel/parser'

const source = fs.readFileSync(new URL('../../examples/campus.js', import.meta.url), 'utf8')

const businessTilesets = [
  'SM_NH_Terr/tileset.json',
  'SM_NH_Building/tileset.json',
  'SM_NH_YFL/SW/tileset.json',
  'SM_NH_ZHL/SW/tileset.json',
  'SM_NH_SYL1/SW/tileset.json',
  'SM_NH_SYL2/SW/tileset.json',
  'SM_NH_XSST1/tileset.json',
  'SM_NH_XSST2/tileset.json',
  'SM_NH_XSCST/tileset.json',
  'SM_NH_ZXST/tileset.json',
  'SM_NH_DDFW/tileset.json',
  'SM_NH_TSG/SW/tileset.json'
]

test('campus uses a configurable asset origin and active building entries without duplicate legacy trees', () => {
  const declarations=parse(source,{sourceType:'module'}).program.body.flatMap(node=>node.declarations||[])
  const list=declarations.find(node=>node.id.name==='BUSINESS_TILESETS').init.elements
  const urls=list.map(node=>node.properties.find(p=>p.key.name==='url').value.value)
  assert.deepEqual(urls,businessTilesets)
  const origin=declarations.find(node=>node.id.name==='DEFAULT_BUSINESS_ASSETS').init.value
  assert.ok(['http:','https:'].includes(new URL(origin).protocol))
  assert.match(source,/const base = query.get\('assets'\) \|\| DEFAULT_BUSINESS_ASSETS/)
})

test('campus example keeps the business model height and tileset quality settings', () => {
  assert.match(source, /height:\s*2/)
  assert.match(source, /maximumScreenSpaceError:\s*32/)
  assert.match(source, /expectedTiles:\s*BUSINESS_TILESETS\.length/)
  assert.match(source, /tiles\.length\s*!==\s*BUSINESS_TILESETS\.length/)
})
