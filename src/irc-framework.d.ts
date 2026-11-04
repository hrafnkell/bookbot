declare module "irc-framework" {
  import type { EventEmitter } from "node:events";

  export interface ConnectOptions {
    host: string;
    port: number;
    nick: string;
    username?: string;
    gecos?: string;
    tls?: boolean;
    rejectUnauthorized?: boolean;
    encoding?: string;
    version?: string | null;
    auto_reconnect?: boolean;
    auto_reconnect_max_wait?: number;
    auto_reconnect_max_retries?: number;
    ping_interval?: number;
    ping_timeout?: number;
    /** Local address to bind; also selects the address family. */
    outgoing_addr?: string;
  }

  export class Client extends EventEmitter {
    constructor(options?: Partial<ConnectOptions>);
    readonly connected: boolean;
    user: { nick: string; username: string; gecos: string };
    connection: { connected: boolean; end(data?: string): void } | null;
    connect(options?: Partial<ConnectOptions>): void;
    quit(message?: string): void;
    join(channel: string, key?: string): void;
    say(target: string, message: string): void;
    raw(...args: string[]): void;
    changeNick(nick: string): void;
  }

  const IRC: { Client: typeof Client };
  export default IRC;
}
