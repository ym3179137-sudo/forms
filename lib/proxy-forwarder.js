import { Server } from "proxy-chain";

const PORT = parseInt(process.env.PROXY_FORWARDER_PORT || "8888", 10);

export async function startProxyForwarder(upstreamUrl) {
    if (!upstreamUrl) {
        console.log("[proxy] no upstream URL, skipping forwarder");
        return null;
    }

    // proxy-chain parses the upstream URL including credentials.
    // it exposes a local proxy on 127.0.0.1:PORT that requires no auth.
    // Chrome connects to the local one; proxy-chain adds the auth for the upstream.
    const server = new Server({
        port: PORT,
        prepareRequestFunction: () => {
            return {
                upstreamProxyUrl: upstreamUrl,
                requestAuthentication: false
            };
        }
    });

    await server.listen();
    const localUrl = `http://127.0.0.1:${PORT}`;
    console.log(`[proxy] forwarder listening at ${localUrl} -> upstream`);
    return { server, localUrl, stop: () => server.close(false) };
}