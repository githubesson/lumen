import "react";

declare module "react" {
  // The type parameter must stay named `T`: TypeScript only merges generic
  // interface declarations whose type parameters are identically named, so
  // renaming it to satisfy no-unused-vars would silently create a second,
  // non-merging HTMLAttributes and break every DOM element's props.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    /**
     * `inert` removes a subtree from hit-testing, the sequential tab order and
     * the accessibility tree. Used on surfaces that stay mounted purely to play
     * an exit transition. Not yet typed by @types/react 18.
     */
    inert?: "" | undefined;
  }
}
