import { extractSessionParameters } from "./utils";
import { TranscriberProxy } from "./transcriberproxy";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const upgradeHeader = request.headers.get("Upgrade");

        if (upgradeHeader !== "websocket") {
            return new Response("Worker expected Upgrade: websocket", { status: 426 });
        }

        if (request.method !== "GET") {
            return new Response("Worker expected GET method", { status: 400 });
        }

        const { url, sessionId, transcribe, connect } = extractSessionParameters(request.url);

        if (!url.pathname.endsWith("/events") && !url.pathname.endsWith("/transcribe")) {
            return new Response("Bad URL", { status: 400 });
        }

        if (transcribe) {
            const webSocketPair = new WebSocketPair();
            const [client, server] = Object.values(webSocketPair);

            server.accept();

            const session = new TranscriberProxy(server, env);

            if (connect) {
                try {
                    const outbound = new WebSocket(connect, ['transcription']);
                    // TODO: pass auth info to this websocket
                    session.on("closed", () => {
                        outbound.close();
                        server.close();
                    });
                    session.on("message", (data: any) => {
                        outbound.send(data);
                    })

                    outbound.addEventListener("close", () => {
                        // TODO: reconnect?
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return new Response(`Failed to connect to WebSocket: ${message}`, { status: 400 })
                }
            }
            else {
                if (!sessionId) {
                    return new Response("Missing sessionId or connect param", { status: 400 });
                }

                // Connect to transcriptionator durable object to relay messages
                const stub = env.TRANSCRIPTIONATOR.getByName(sessionId);

                session.on("closed", () => {
                    // Notify the Durable Object that the session closed
                    stub.notifySessionClosed();
                    server.close();
                });

                session.on("message", (data: any) => {
                    // Forward transcription messages to the Durable Object for distribution via RPC
                    stub.broadcastMessage(data);
                });
            }

            // Accept the connection and return immediately
            return new Response(null, {
                status: 101,
                webSocket: client,
            });
        } else {
            if (!sessionId) {
                return new Response("Missing sessionId or connect param", { status: 400 });
            }

            // Handle observer: connect to the Durable Object
            const stub = env.TRANSCRIPTIONATOR.getByName(sessionId);
            return stub.fetch(request);
        }
	},
} satisfies ExportedHandler<Env>;

export { Transcriptionator } from "./transcriptionator"
