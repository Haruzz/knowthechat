import { vi } from "vitest";

export class FakeRoomSocket {
  static instances: FakeRoomSocket[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn<(data: string) => void>();
  close = vi.fn();

  constructor(
    url: string | URL,
    readonly protocols: string[],
  ) {
    this.url = String(url);
    FakeRoomSocket.instances.push(this);
  }

  message(data: unknown) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: typeof data === "string" ? data : JSON.stringify(data),
      }),
    );
  }

  disconnect() {
    this.onclose?.();
  }
}
