// node-q's codec, which its own declarations do not describe.
declare module "node-q/lib/c.js" {
  export function serialize(value: unknown): Buffer;
  export function deserialize(
    message: Buffer,
    nanos2date: boolean,
    flipTables: boolean,
    emptyChar2null: boolean,
    long2number: boolean,
  ): unknown;
}

