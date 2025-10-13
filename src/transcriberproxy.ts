import { OutgoingConnection } from './OutgoingConnection';

export class TranscriberProxy {
    private readonly ws: WebSocket;
    private outgoingConnections: Map<string, OutgoingConnection>;
    private eventListeners: Map<string, Array<(...args: any[]) => void>>;

    // Cloudflare workers allow a max of six concurrent outgoing connections.  Leave some room
    // in case we need to do separate fetch() calls or the like.  The JVB should have at most
    // three concurrent speakers.
    private MAX_OUTGOING_CONNECTIONS = 4

    constructor(ws: WebSocket, env: Env) {
        this.ws = ws;
        this.outgoingConnections = new Map<string, OutgoingConnection>;
        this.eventListeners = new Map();

        this.ws.addEventListener('close', () => {
            this.ws.close();
            this.emit("closed");
        })

        this.ws.addEventListener('message', async (event) => {
            let parsedMessage;
            try {
                parsedMessage = JSON.parse(event.data as string);
            } catch (parseError) {
                console.error('Failed to parse message as JSON:', parseError);
                parsedMessage = { raw: event.data, parseError: true };
            }
             // TODO: are there any other events that need to be handled?
             if (parsedMessage && parsedMessage.event === 'media') {
                this.handleMediaEvent(parsedMessage, env);
             }
        });

    }

    handleMediaEvent(parsedMessage: any, env: any): void {
        const tag = parsedMessage.media?.tag;
        if (tag) {
            if (!this.outgoingConnections.has(tag)) {
                while (this.outgoingConnections.size > this.MAX_OUTGOING_CONNECTIONS) {
                    const firstKey = this.outgoingConnections.keys().next().value!
                    this.outgoingConnections.get(firstKey)?.close();
                    this.outgoingConnections.delete(firstKey);
                }

                const connection = new OutgoingConnection(tag, env);

                connection.onCompleteTranscription = (message) => {
                    this.emit("message", message)
                }
                connection.onClosed = (tag) => {
                    this.outgoingConnections.delete(tag)
                }

                this.outgoingConnections.set(tag, connection);
                console.log(`Created outgoing connection entry for tag: ${tag}`);
            }

            const connection = this.outgoingConnections.get(tag);
            if (connection) {
                connection.handleMediaEvent(parsedMessage);
            }
        }
    }

    on(event: string, listener: (...args: any[]) => void): void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event)!.push(listener);
    }

    emit(event: string, ...args: any[]): void {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            listeners.forEach(listener => listener(...args));
        }
    }
}