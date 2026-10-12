const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "wimgpt-dashboard",
      cwd: __dirname,
      script: "server.mjs",
      interpreter: process.execPath,
      args: "--host 127.0.0.1 --port 8787 --state-dir ./.wimgpt",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 10000,
      listen_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: path.join(__dirname, ".wimgpt", "pm2-out.log"),
      error_file: path.join(__dirname, ".wimgpt", "pm2-error.log"),
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
