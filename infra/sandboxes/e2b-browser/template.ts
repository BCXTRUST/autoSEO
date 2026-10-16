import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Template, waitForFile } from "e2b";

const directory = dirname(fileURLToPath(import.meta.url));

export function autoseoBrowserTemplate() {
  return Template({ fileContextPath: directory })
    .fromTemplate("desktop")
    .aptInstall([
      "locales",
      "fonts-dejavu",
      "fonts-liberation",
      "x11-xserver-utils",
      "x11-utils",
      "imagemagick",
      "netcat-openbsd",
    ])
    .runCmd("sed -i 's/# de_DE.UTF-8/de_DE.UTF-8/' /etc/locale.gen && locale-gen", {
      user: "root",
    })
    .runCmd(
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
      { user: "root" },
    )
    .runCmd(
      "mkdir -p /home/user/.autoseo && cd /home/user/.autoseo && npm install --no-save --no-package-lock playwright@1.62.1 && chown -R user:user /home/user/.autoseo",
      { user: "root" },
    )
    .runCmd(
      "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright /home/user/.autoseo/node_modules/.bin/playwright install --with-deps chromium && chmod -R a+rX /ms-playwright",
      { user: "root" },
    )
    .copy("start.sh", "/opt/autoseo/start.sh", { mode: 0o755, user: "root" })
    .setStartCmd("/opt/autoseo/start.sh", waitForFile("/tmp/autoseo-display-ready"));
}
