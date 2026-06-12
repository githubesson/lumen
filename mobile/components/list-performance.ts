import type { FlashListProps } from "@shopify/flash-list";
import type { FlatListProps } from "react-native";

type ListPerformanceProps = Pick<
  FlatListProps<unknown>,
  | "initialNumToRender"
  | "maxToRenderPerBatch"
  | "removeClippedSubviews"
  | "updateCellsBatchingPeriod"
  | "windowSize"
>;

/**
 * Keep long music lists from retaining hundreds of row trees after a full
 * scroll. The row height is fixed, so a tighter render window is reliable and
 * materially reduces native view and image pressure on album-sized lists.
 */
export const TRACK_LIST_PERFORMANCE_PROPS = {
  initialNumToRender: 14,
  maxToRenderPerBatch: 8,
  removeClippedSubviews: true,
  updateCellsBatchingPeriod: 32,
  windowSize: 5,
} as const satisfies ListPerformanceProps;

type FlashListPerformanceProps = Pick<
  FlashListProps<unknown>,
  | "drawDistance"
  | "maintainVisibleContentPosition"
  | "maxItemsInRecyclePool"
  | "overrideProps"
  | "removeClippedSubviews"
>;

export const TRACK_FLASH_LIST_PERFORMANCE_PROPS = {
  drawDistance: 448,
  maintainVisibleContentPosition: { disabled: true },
  maxItemsInRecyclePool: 36,
  overrideProps: { initialDrawBatchSize: 14 },
  removeClippedSubviews: true,
} as const satisfies FlashListPerformanceProps;
