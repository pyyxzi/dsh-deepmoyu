const path = require('node:path')
const os = require('node:os')

const ROOT = path.resolve(__dirname, '../..')
const CLIENT = path.join(ROOT, 'client.js')
const OUTPUT_ROOT = process.env.QA_OUTPUT_DIR
  ? path.resolve(process.env.QA_OUTPUT_DIR)
  : path.join(os.tmpdir(), 'dsh-deepmoyu-qa')
const qaOutput = (name) => path.join(OUTPUT_ROOT, name)

module.exports = { ROOT, CLIENT, OUTPUT_ROOT, qaOutput }
