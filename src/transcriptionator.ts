import { DurableObject} from "cloudflare:workers"

import { TranscriberProxy } from "./transcriberproxy";
import { extractSessionParameters } from "./utils";

export class Transcriptionator extends DurableObject<Env> {
    private observers: Set<WebSocket>;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        this.observers = new Set();
        this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        server.accept();

        const { transcribe } = extractSessionParameters(request.url);

        console.log("New WebSocket connection:", { url: request.url, transcribe });

        if (transcribe) {
            const session = new TranscriberProxy(server, this.env);

            session.on("closed", () => {
                // Close observers?
            });

            session.on("message", (data: any) => {
                console.log(`Sending message ${data} to ${this.observers.size} observers`);
                this.observers.forEach((observer) => {
                    observer.send(data);
                });
            });
        } else {
            this.observers.add(server);
            server.addEventListener("close", () => {
                this.observers.delete(server);
                server.close();
            });
        }

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }

}