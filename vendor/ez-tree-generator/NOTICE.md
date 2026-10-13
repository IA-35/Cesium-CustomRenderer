# Official EZ-Tree geometry generator

Unmodified `src/lib` and `src/app/public/textures/leaves/pine.png` from
https://github.com/dgreenheck/ez-tree at commit
`dcf309bd86bd521083d9c70f01f2de45fdc7c457` (MIT; see LICENSE).

Used only by `scripts/prepare-lightweight-vegetation.cjs` during asset preparation.
Three.js and this generator are not shipped in the campus browser runtime.
The npm 1.1.0 release predates the shared-skeleton `createGeometry(detail)` API,
so this source snapshot is pinned explicitly instead of silently using that release.
