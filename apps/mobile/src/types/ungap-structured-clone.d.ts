declare module "@ungap/structured-clone" {
  export interface StructuredCloneOptions {
    transfer?: readonly unknown[];
  }

  export default function structuredClone<T>(
    value: T,
    options?: StructuredCloneOptions,
  ): T;
}
