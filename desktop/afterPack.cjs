// Ad-hoc code-sign the macOS app after packaging.
//
// CI has no Apple Developer certificate, so the build is otherwise unsigned —
// and a fully unsigned app will NOT launch on Apple Silicon (Gatekeeper kills
// it outright). An ad-hoc signature (`codesign -s -`) lets it run after the
// user clears quarantine / right-click → Open. No-op on Windows/Linux.
const { execSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
    console.log('ad-hoc signed', appPath)
  } catch (e) {
    console.warn('ad-hoc signing failed (app may not open on Apple Silicon):', e.message)
  }
}
