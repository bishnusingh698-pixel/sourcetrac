/**
 * Guards the Render build against missing build-time dependencies.
 *
 * Render runs `npm ci` with devDependencies omitted, so anything imported by
 * vite.config.ts or react-router.config.ts has to survive that or the build
 * dies with ERR_MODULE_NOT_FOUND ("Cannot find package 'vite-tsconfig-paths'")
 * or "prisma: not found". Both have happened on real deploys, so this is
 * cheap insurance that runs as part of `npm run check`.
 *
 * `.npmrc` sets `include=dev`, which re-adds devDependencies during the build,
 * so dev-only build tools are reported but not treated as failures.
 */
const fs = require("node:fs");

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const npmrc = fs.readFileSync(".npmrc", "utf8");

const hasIncludeDev = /^include=dev\s*$/m.test(npmrc);

const problems = [];
if (!hasIncludeDev) {
  problems.push(
    ".npmrc is missing 'include=dev'; Render's build would omit devDependencies",
  );
}

// Every bare specifier imported by the build-time configs.
const specifiers = new Set();
for (const file of ["vite.config.ts", "react-router.config.ts"]) {
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec.startsWith(".") || spec.startsWith("node:")) continue;
    specifiers.add(
      spec.startsWith("@")
        ? spec.split("/").slice(0, 2).join("/")
        : spec.split("/")[0],
    );
  }
}

const devOnly = [];
for (const name of [...specifiers].sort()) {
  if (pkg.dependencies?.[name]) continue;
  if (pkg.devDependencies?.[name]) {
    devOnly.push(name);
    continue;
  }
  problems.push(`${name} is imported by a build config but is not declared`);
}

if (problems.length > 0) {
  console.error("build dependency check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `ok  build config deps (${[...specifiers].sort().join(", ")})` +
    (devOnly.length > 0 ? ` [dev-only, kept by include=dev: ${devOnly.join(", ")}]` : ""),
);
