import { DurableObject} from "cloudflare:workers"

import { TranscriberProxy } from "./transcriberproxy";
import { extractSessionParameters } from "./utils";

export class Transcriptionator extends DurableObject<Env> {
    private transcribers: Map<string, TranscriberProxy>;
    private observers: Set<WebSocket>;

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);

        this.transcribers = new Map();
        this.observers = new Set();
        this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
        const webSocketPair = new WebSocketPair();
        const [client, server] = Object.values(webSocketPair);

        server.accept();

        const { tag, transcribe } = extractSessionParameters(request.url);

        console.log("New WebSocket connection:", { url: request.url, tag, transcribe });

        if (transcribe) {
            const session = new TranscriberProxy(server, tag!, this.env);

            session.on("closed", () => {
                this.transcribers.delete(tag!);
            });

            session.on("message", (data: any) => {
                this.observers.forEach((observer) => {
                    observer.send(data);
                });
            });

            this.transcribers.set(tag!, session);
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