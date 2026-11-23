/*
 * Bot settings.
 *
 * config.json is committed and holds placeholders only. Put your real values in
 * config.local.json (same keys), which is gitignored, so your bot token and API key
 * never end up in git. Any key in config.local.json overrides config.json.
 */
const fs = require('fs');
const path = require('path');

const base = require('./config.json');
const localPath = path.join(__dirname, 'config.local.json');
const local = fs.existsSync(localPath) ? JSON.parse(fs.readFileSync(localPath, 'utf8')) : {};

const config = { ...base, ...local };

const missing = ['token', 'clientId', 'guildId', 'apiBaseUrl', 'apiKey']
    .filter((k) => !config[k] || /^YOUR-.*-HERE$/.test(String(config[k])));
if (missing.length) {
    console.warn(`[config] Not set: ${missing.join(', ')}. Add them to bot/config.local.json (see bot/README.md).`);
}

module.exports = config;
