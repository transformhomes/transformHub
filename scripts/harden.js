// Switches off Electron features the hub never uses, so they cannot be turned against it:
//   - running the app's engine as a plain Node.js program (ELECTRON_RUN_AS_NODE)
//   - the NODE_OPTIONS variable and the --inspect debugging switches
// and switches on encrypted cookies. Packaged builds also only load the app from the sealed app.asar file.
//
// Two ways it runs:
//   npm run harden      hardens the Electron program inside node_modules (also runs after "npm install")
//   npm run dist        electron-builder calls afterPack below to harden the installer's copy
const path = require('path');
const fs = require('fs');

async function harden(exePath, { packaged }) {
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');
  await flipFuses(exePath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: !!packaged,
  });
}

function localElectron() {
  const dist = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
  const name = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
  return path.join(dist, name);
}

// electron-builder hook (see "afterPack" in package.json)
exports.default = async function afterPack(context) {
  const exe = process.platform === 'win32'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe')
    : path.join(context.appOutDir, context.packager.executableName);
  await harden(exe, { packaged: true });
  console.log('Hardened', exe);
};

if (require.main === module) {
  const exe = localElectron();
  if (!fs.existsSync(exe)) { console.log('harden: Electron program not found yet, skipping.'); process.exit(0); }
  harden(exe, { packaged: false })
    .then(() => console.log('Hardened', exe))
    .catch((err) => { console.error('harden: could not change the Electron program (' + err.message + '). The hub still works.'); process.exit(0); });
}
