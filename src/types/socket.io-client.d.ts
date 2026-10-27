/**
 * The slice of socket.io-client 2.x that the Socket API monitor uses. 2.x
 * ships no types, and Lovense's socket server requires a 2.x client.
 */
declare module 'socket.io-client' {
  namespace io {
    interface ConnectOpts {
      path?: string;
      transports?: string[];
      reconnection?: boolean;
      reconnectionDelay?: number;
      reconnectionDelayMax?: number;
      timeout?: number;
      forceNew?: boolean;
    }

    interface Socket {
      connected: boolean;
      on(event: string, fn: (...args: any[]) => void): Socket;
      emit(event: string, ...args: unknown[]): Socket;
      close(): Socket;
      removeAllListeners(): Socket;
    }
  }

  function io(url: string, opts?: io.ConnectOpts): io.Socket;
  export = io;
}
