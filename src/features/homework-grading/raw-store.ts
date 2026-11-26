import { GradingError } from './contracts.ts';
/** Raw content has no SQLite/BLOB, filesystem, backup or persistent cache path. */
export interface RawObject {
  key: string;
  bytes: Uint8Array;
  mime: string;
}
export interface RawStore {
  put(scope: string, value: RawObject): Promise<void>;
  get(scope: string, key: string): Promise<RawObject | undefined>;
  list(scope: string): Promise<string[]>;
  delete(scope: string, key: string): Promise<void>;
  readonly name: string;
}
export class MemoryRawStore implements RawStore {
  readonly name = 'volatile_process_memory';
  private objects = new Map<string, Map<string, RawObject>>();
  private bytes = 0;
  private readonly maxBytes: number;
  constructor(maxBytes = 64 * 1024 * 1024) {
    this.maxBytes = maxBytes;
  }
  async put(scope: string, value: RawObject) {
    const old = this.objects.get(scope)?.get(value.key);
    const nextBytes =
      this.bytes + value.bytes.length - (old?.bytes.length ?? 0);
    if (nextBytes > this.maxBytes)
      throw new GradingError('RAW_CAPACITY_EXCEEDED', 503);
    let objects = this.objects.get(scope);
    if (!objects) {
      objects = new Map();
      this.objects.set(scope, objects);
    }
    old?.bytes.fill(0);
    objects.set(value.key, { ...value, bytes: value.bytes.slice() });
    this.bytes = nextBytes;
  }
  async get(scope: string, key: string) {
    const object = this.objects.get(scope)?.get(key);
    return object ? { ...object, bytes: object.bytes.slice() } : undefined;
  }
  async list(scope: string) {
    return [...(this.objects.get(scope)?.keys() ?? [])];
  }
  async delete(scope: string, key: string) {
    const objects = this.objects.get(scope);
    const value = objects?.get(key);
    this.bytes -= value?.bytes.length ?? 0;
    value?.bytes.fill(0);
    objects?.delete(key);
    if (!objects?.size) this.objects.delete(scope);
  }
}
