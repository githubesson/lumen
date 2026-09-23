/**
 * Whether a rejected share-sheet or share-extension call was just the user
 * backing out. The native share APIs report that as an error whose message
 * mentions cancelling or dismissing, which must not surface as a failure.
 */
export function isShareDismissal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("dismiss") ||
    message.includes("did not share")
  );
}
