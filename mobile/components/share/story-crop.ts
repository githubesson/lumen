import { type StoryBackgroundCrop } from "@music-library/core";

/** Instagram story canvas aspect ratio (portrait 9:16). */
export const STORY_ASPECT = 9 / 16;

/** A photo picked from the library to use as a story background. */
export interface PickedStoryBackground {
  uri: string;
  name: string;
  type: string;
  width: number;
  height: number;
}

/**
 * Centered story-aspect crop covering as much of the image as possible,
 * expressed in normalized (0..1) image coordinates.
 */
export function initialStoryCrop(
  width: number,
  height: number,
): StoryBackgroundCrop {
  const imageAspect = width / Math.max(1, height);
  if (imageAspect > STORY_ASPECT) {
    const cropWidth = STORY_ASPECT / imageAspect;
    return {
      x: (1 - cropWidth) / 2,
      y: 0,
      width: cropWidth,
      height: 1,
    };
  }
  const cropHeight = imageAspect / STORY_ASPECT;
  return {
    x: 0,
    y: (1 - cropHeight) / 2,
    width: 1,
    height: cropHeight,
  };
}

/** Keeps a normalized crop rectangle fully inside the image bounds. */
export function clampCrop(crop: StoryBackgroundCrop): StoryBackgroundCrop {
  const width = Math.max(0.01, Math.min(1, crop.width));
  const height = Math.max(0.01, Math.min(1, crop.height));
  return {
    x: Math.max(0, Math.min(1 - width, crop.x)),
    y: Math.max(0, Math.min(1 - height, crop.y)),
    width,
    height,
  };
}

/**
 * Pixel-space layout for the crop editor: where the contain-fitted image sits
 * inside the editor frame and where the crop window sits on top of it.
 * Returns null until the frame has been measured.
 */
export function cropEditorMetrics(
  image: PickedStoryBackground,
  width: number,
  height: number,
  crop: StoryBackgroundCrop,
) {
  if (width <= 0 || height <= 0) return null;
  const imageAspect = image.width / Math.max(1, image.height);
  const frameAspect = width / height;
  const imageWidth =
    imageAspect > frameAspect ? width : Math.max(1, height * imageAspect);
  const imageHeight =
    imageAspect > frameAspect ? Math.max(1, width / imageAspect) : height;
  const imageLeft = (width - imageWidth) / 2;
  const imageTop = (height - imageHeight) / 2;
  const safeCrop = clampCrop(crop);
  return {
    imageLeft,
    imageTop,
    imageWidth,
    imageHeight,
    cropLeft: imageLeft + safeCrop.x * imageWidth,
    cropTop: imageTop + safeCrop.y * imageHeight,
    cropWidth: safeCrop.width * imageWidth,
    cropHeight: safeCrop.height * imageHeight,
  };
}
