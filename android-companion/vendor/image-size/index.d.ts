/**
 * Types for the locally-owned image header reader in this directory.
 *
 * The exported shape mirrors the upstream `image-size` package for the parts
 * this project uses, so `require("image-size")` keeps typechecking where it is
 * referenced. See README.md for why the package is vendored and for the two
 * deliberate differences from upstream.
 */

export interface ISize {
  width: number;
  height: number;
  type?: string;
}

/** The formats this reader parses. Anything else is refused. */
export type ImageType = "png" | "jpg" | "gif" | "bmp" | "webp";

export type CallbackFn = (error: Error | null, size?: ISize) => void;

/** Dimensions of image bytes. Synchronous. */
export declare function imageSize(input: Uint8Array): ISize;
/** Dimensions of the named file. Synchronous. Only image extensions are read. */
export declare function imageSize(input: string): ISize;
/** Dimensions of the named file, delivered to `callback`. */
export declare function imageSize(input: string, callback: CallbackFn): void;

/** Refuse the path-taking form entirely. */
export declare function disableFS(value: boolean): void;
/** Refuse the named types with `disabled file type: <type>`. */
export declare function disableTypes(disabled: string[]): void;
/** Bound the parallel reads used by the callback form. */
export declare function setConcurrency(value: number): void;
/** The formats this reader parses. */
export declare const types: readonly ImageType[];

declare const defaultExport: typeof imageSize & {
  default: typeof imageSize;
  imageSize: typeof imageSize;
  disableFS: typeof disableFS;
  disableTypes: typeof disableTypes;
  setConcurrency: typeof setConcurrency;
  types: readonly ImageType[];
};

export default defaultExport;
