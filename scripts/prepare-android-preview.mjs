/**
 * Build inputs for an Android Trusted Web Activity of the hosted mobile app.
 * Install build-only tooling: npm install --prefix .local/audit-tools --ignore-scripts @bubblewrap/cli@1.27.0
 * Generated Android sources and signing keys stay outside Git.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
const { TwaManifest, TwaGenerator } = await import(
  pathToFileURL(
    resolve('.local/audit-tools/node_modules/@bubblewrap/core/dist/index.js'),
  ).href
);
const origin = 'https://axr-academy-hosted.pogoo.workers.dev';
const web = JSON.parse(
  readFileSync('src/features/academy-operations/app.webmanifest', 'utf8'),
);
const manifest = TwaManifest.fromWebManifestJson(
  new URL(origin + '/app.webmanifest'),
  web,
);
manifest.packageId = 'com.axr.academy.preview';
manifest.name = 'AXR 학원';
manifest.launcherName = 'AXR 학원';
manifest.startUrl = '/';
manifest.appVersionCode = 1;
manifest.appVersionName = '0.1.0-preview';
manifest.minSdkVersion = 24;
manifest.enableNotifications = false;
manifest.fallbackType = 'customtabs';
manifest.signingKey = {
  path: '.local/android-preview.keystore',
  alias: 'axr-preview',
};
// A temporary local asset server makes the package reproducible before deploy.
const assets = createServer((req, res) => {
  if (req.url === '/app.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify(web));
  } else if (req.url === '/assets/app-512.png') {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(readFileSync('src/features/academy-operations/assets/app-512.png'));
  } else res.writeHead(404).end();
});
assets.listen(0, '127.0.0.1');
await once(assets, 'listening');
const iconOrigin = 'http://127.0.0.1:' + assets.address().port;
manifest.webManifestUrl = new URL(iconOrigin + '/app.webmanifest');
manifest.iconUrl = iconOrigin + '/assets/app-512.png';
manifest.maskableIconUrl = manifest.iconUrl;
const dir = resolve('.local/android-preview');
mkdirSync(dir, { recursive: true });
try {
  await new TwaGenerator().createTwaProject(dir, manifest, console);
} finally {
  assets.close();
  assets.closeAllConnections();
}
const appBuild = resolve(dir, 'app/build.gradle');
writeFileSync(
  appBuild,
  readFileSync(appBuild, 'utf8').replaceAll(iconOrigin, origin),
);
const buildFile = resolve(dir, 'build.gradle');
writeFileSync(
  buildFile,
  readFileSync(buildFile, 'utf8')
    .replaceAll('jcenter()', 'mavenCentral()')
    .replace('gradle:8.9.1', 'gradle:8.13.0'),
);
const wrapper = resolve(dir, 'gradle/wrapper/gradle-wrapper.properties');
writeFileSync(
  wrapper,
  readFileSync(wrapper, 'utf8')
    .replace(/gradle-[0-9.]+-all.zip/, 'gradle-8.14.3-bin.zip')
    .replace(/gradle-[0-9.]+-bin.zip/, 'gradle-8.14.3-bin.zip'),
);
if (process.env.ANDROID_HOME)
  writeFileSync(
    resolve(dir, 'local.properties'),
    'sdk.dir=' + process.env.ANDROID_HOME.replaceAll('\\', '/') + '\n',
  );
console.log(
  'Android preview generated at .local/android-preview. Run gradlew assembleDebug there; release signing is separate.',
);
