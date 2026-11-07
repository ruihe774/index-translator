// A sideways swipe on a touch screen, told apart from a scroll, a long press or a back gesture by where the
// finger went and how fast. Pure, so bun test needs no DOM; full-view.ts listens for the touches.

/** One finger from where it touched down to where it is, in viewport pixels and milliseconds. */
export interface TouchTrack {
  startX: number;
  startY: number;
  startTime: number;
  x: number;
  y: number;
  time: number;
  /** The farthest the finger has been above or below where it started. */
  drift: number;
}

export const SWIPE = {
  /** The least sideways distance. */
  distance: 60,
  /** How many times farther sideways than up or down it must go. */
  ratio: 2,
  /** The longest a swipe takes; a long press starts a text selection instead. */
  duration: 600,
  /** A touch starting this close to a side of the screen is the system's back or forward gesture. */
  edge: 24,
} as const;

export function startTrack(x: number, y: number, time: number): TouchTrack {
  return { startX: x, startY: y, startTime: time, x, y, time, drift: 0 };
}

export function moveTrack(track: TouchTrack, x: number, y: number, time: number): void {
  track.x = x;
  track.y = y;
  track.time = time;
  track.drift = Math.max(track.drift, Math.abs(y - track.startY));
}

/** Which way the finger swiped on a screen `width` wide, or null when it was not a sideways swipe. */
export function swipeOf(track: TouchTrack, width: number): "left" | "right" | null {
  const dx = track.x - track.startX;
  if (
    track.startX < SWIPE.edge ||
    track.startX > width - SWIPE.edge ||
    track.time - track.startTime > SWIPE.duration ||
    Math.abs(dx) < SWIPE.distance ||
    Math.abs(dx) < SWIPE.ratio * Math.max(track.drift, Math.abs(track.y - track.startY))
  ) {
    return null;
  }
  return dx < 0 ? "left" : "right";
}
