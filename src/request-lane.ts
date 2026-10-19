// A bounded queue for one kind of read. At most `limit` requests run at once
// and the rest wait in order. Calls with the same key that arrive while one
// for that key is still WAITING share it, since nothing has been sent yet and
// the answer it brings back is as fresh as a request of their own would be.
// A call arriving after its key's request has started sends its own, so a
// read that follows a write never answers with what the server held before.

export interface RequestLane {
  run<T>(key: string, send: () => Promise<T>): Promise<T>;
}

interface Waiting {
  send: () => Promise<unknown>;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export function createRequestLane(limit: number): RequestLane {
  const queue: string[] = [];
  const waiting = new Map<string, Waiting>();
  let running = 0;

  const pump = (): void => {
    while (running < limit && queue.length > 0) {
      const key = queue.shift()!;
      const entry = waiting.get(key)!;
      waiting.delete(key);
      running += 1;
      let sent: Promise<unknown>;
      try {
        sent = entry.send();
      } catch (err) {
        sent = Promise.reject(err);
      }
      sent.then(entry.resolve, entry.reject).finally(() => {
        running -= 1;
        pump();
      });
    }
  };

  return {
    run<T>(key: string, send: () => Promise<T>): Promise<T> {
      const pending = waiting.get(key);
      if (pending !== undefined) return pending.promise as Promise<T>;
      let resolve!: (value: unknown) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      waiting.set(key, { send, promise, resolve, reject });
      queue.push(key);
      pump();
      return promise as Promise<T>;
    },
  };
}
