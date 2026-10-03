// 以 Electron 自带 Node 运行 vitest（DR-006）：
// better-sqlite3 统一编译为 Electron ABI（postinstall electron-rebuild），
// 测试与主进程共用同一 NODE_MODULE_VERSION，避免双 ABI 漂移。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronBin = require('electron') // 已安装时返回二进制路径字符串

const child = spawn(electronBin, ['node_modules/vitest/vitest.mjs', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
child.on('exit', (code) => process.exit(code ?? 1))
