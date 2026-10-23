import { ApiError } from "@music-library/core";
import { File } from "expo-file-system";
import { fetch as reactNativeFetch } from "whatwg-fetch";

/** React Native's FormData lists its parts; the DOM typings don't know that. */
type NativeFormData = FormData & {
  getParts(): ({ uri: string; name?: string } | { string: string })[];
};

/**
 * The fetch uploads go through. Expo's fetch, the global one since SDK 57,
 * refuses React Native's `{ uri, name, type }` file parts ("Unsupported
 * FormDataPart implementation"), so this is React Native's own fetch
 * (whatwg-fetch over its XMLHttpRequest), which reads the files natively.
 *
 * On iOS that request never settles when a file can't be read: RCTNetworking
 * logs the error and drops it without telling JS, and uploads have no
 * deadline. A picked file that has since left the cache is the likely cause,
 * so those are refused here instead.
 */
export async function formFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const body = init?.body;
  if (body instanceof FormData) {
    for (const part of (body as NativeFormData).getParts()) {
      if ("uri" in part && isMissingFile(part.uri)) {
        throw new ApiError(0, `${part.name ?? "A file"} is no longer on this device. Choose it again.`);
      }
    }
  }
  return reactNativeFetch(input, init);
}

function isMissingFile(uri: string): boolean {
  if (!uri.startsWith("file:")) return false;
  try {
    return !new File(uri).exists;
  } catch {
    // A URI expo-file-system can't parse: let React Native try it.
    return false;
  }
}
