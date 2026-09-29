import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const env = { ...process.env }
if (process.platform === 'win32') {
  // Keep esbuild's temporary files on the project volume. On some Windows
  // setups, esbuild cannot delete files in the user profile's Temp directory.
  const temp = fileURLToPath(new URL('./node_modules/.cache/esbuild-temp/', import.meta.url))
  mkdirSync(temp, { recursive: true })
  env.TEMP = temp
  env.TMP = temp
}

const vite = fileURLToPath(new URL('./node_modules/vite/bin/vite.js', import.meta.url))
const child = spawn(process.execPath, [vite, 'build', ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
})
child.on('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
