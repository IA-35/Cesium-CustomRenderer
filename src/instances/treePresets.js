// Species-to-preset mapping for the procedural tree source.
//
// The manifest already carries `species`, `form` and `generatorPreset` per prototype, but the
// collection used to load `Pine Medium` for every one of them. Two of the three shipped
// prototypes therefore rendered as the wrong species (see the table below), which is the main
// reason a stand of 720 procedural trees read as one repeated shape.
//
// The pinned runtime only bundles five presets:
//
//   Oak Medium   deciduous, round crown
//   Pine Medium  evergreen, spreading
//   Aspen Medium deciduous, slender
//   Ash Medium   deciduous, tall
//   Bush 2       shrub
//
// The generator repository ships fifteen (large/medium/small per species), but only these five
// are available at runtime. The mapping below is therefore explicit rather than a passthrough of
// `generatorPreset`: a species whose exact preset is absent is pointed at the closest available
// form, and that substitution is recorded here instead of being hidden in a call site.
//
// Ginkgo has no preset and no ginkgo leaf card. It is a broadleaf deciduous tree, so it maps to a
// deciduous crown and is explicitly marked `approximate` — the foliage silhouette reads correctly
// at stand distance, but the individual leaf shape is not ginkgo. Callers that need a real ginkgo
// leaf must supply a GLB prototype instead.
export const TREE_SPECIES = Object.freeze({
  '松树': Object.freeze({ preset: 'Pine Medium', form: 'spreading' }),
  // Columnar conifer. The runtime has no `Pine Small`, so the spreading pine carries the shape
  // and the variance below narrows the crown to approximate a column.
  '松柏': Object.freeze({ preset: 'Pine Medium', form: 'columnar',
    crownScale: 0.62, heightScale: 1.12 }),
  // Broadleaf approximation; no ginkgo preset or leaf card exists in the pinned runtime.
  '银杏': Object.freeze({ preset: 'Oak Medium', form: 'rounded', approximate: 'ginkgo' }),
  // Prototype naming falls back to the manifest id when `species` is absent.
  '松树01': Object.freeze({ preset: 'Oak Medium', form: 'rounded' })
})

// The stand must not repeat one silhouette. The previous build cycled three literals, so 720
// points showed three trees. Each prototype now derives a pool of distinct seeds from its own id,
// and a point picks from that pool by its stable id hash.
const SEED_POOL_SIZE = 12

function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b)
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35)
  return (hash ^ (hash >>> 16)) >>> 0
}

/**
 * Resolve the preset name and shape overrides for one prototype.
 *
 * `generatorPreset` from the manifest wins when the runtime actually bundles that name, so an
 * authored manifest stays authoritative; otherwise the species table decides and the substitution
 * is reported through `approximate`.
 */
export function resolveTreePreset(asset = {}, availablePresets = []) {
  const species = TREE_SPECIES[asset.species] || TREE_SPECIES[asset.id]
  const bundled = name => availablePresets.includes(name)
  const authored = asset.generatorPreset
  // An authored preset that the runtime does not bundle would silently fall back to defaults
  // inside loadPreset, so it is only honoured when it is actually present.
  const preset = (authored && bundled(authored)) ? authored
    : (species && bundled(species.preset)) ? species.preset
      : (bundled('Pine Medium') ? 'Pine Medium' : availablePresets[0])
  const resolved = species && species.preset === preset ? species : null
  return {
    preset,
    species: asset.species || null,
    form: (resolved && resolved.form) || asset.form || null,
    crownScale: resolved?.crownScale,
    heightScale: resolved?.heightScale,
    approximate: resolved?.approximate || null,
    usedAuthoredPreset: !!(authored && bundled(authored))
  }
}

/**
 * Per-prototype seed pool. Distinct seeds give distinct branch topology, which is what makes the
 * stand stop reading as one repeated tree; a single seed per prototype would only rotate it.
 */
export function seedPool(prototypeId, size = SEED_POOL_SIZE) {
  const seeds = []
  for (let index = 0; index < size; index++) {
    // Spread across the 16-bit range the generator's RNG expects, avoiding 0.
    seeds.push(1 + (fnv1a(`${prototypeId}:seed:${index}`) % 0xfffe))
  }
  return seeds
}

export { fnv1a }
