import "dotenv/config";
import { getSecret } from "./keys.js";

try {
    const url = await getSecret("PROXY_URL");
    if (url) process.stdout.write(url.trim());
} catch (_) { }
process.exit(0);