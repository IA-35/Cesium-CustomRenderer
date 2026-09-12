// The application uses external lookup files; the standalone SDK build replaces
// this module with data URLs so it can ship as a single JavaScript file.
export const smaaLookupUrl = (C, name) => C.buildModuleUrl(`../rendering/smaa/${name}`)
