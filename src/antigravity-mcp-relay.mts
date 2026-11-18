import { connect } from 'node:net'

const socket = connect(process.argv[2] ?? '')
socket.on('connect', () => {
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})
socket.on('error', () => {
  process.stderr.write('Antigravity tool bridge unavailable\n')
  process.exitCode = 1
  process.stdin.destroy()
})
socket.on('close', () => {
  process.stdin.destroy()
})
process.stdout.on('error', () => socket.destroy())
process.on('SIGTERM', () => {
  socket.destroy()
  process.stdin.destroy()
})
