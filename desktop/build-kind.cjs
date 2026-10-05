// Which build this is, baked into its package.json when it is packaged.
// `npm run pack:test` sets swiffBuild to "test": the build tried on the GEEKOM
// and in the VM, which also trusts the developer's own image-set key
// (image-set.cjs trustOf) and says in its rail that it is a test build. Every
// other build, the normal pack and an unpackaged run included, is a release
// build. Nothing read at run time changes it.

/** True only for a build packaged by `npm run pack:test`. */
function testBuild(pkg = require("./package.json")) {
  return pkg?.swiffBuild === "test";
}

module.exports = { testBuild };
