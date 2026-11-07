import { describe, expect, test } from "bun:test";

import { moveTrack, startTrack, SWIPE, swipeOf, type TouchTrack } from "../public/swipe";

const WIDTH = 360;

/** A finger touching down at `from` and passing through `points` ([x, y, ms after the start]). */
function track(from: [number, number], ...points: [number, number, number][]): TouchTrack {
  const t = startTrack(from[0], from[1], 1000);
  for (const [x, y, ms] of points) {
    moveTrack(t, x, y, 1000 + ms);
  }
  return t;
}

describe("swipeOf", () => {
  test("a quick sideways move is a swipe the way the finger went", () => {
    expect(swipeOf(track([250, 300], [200, 305, 80], [150, 310, 160]), WIDTH)).toBe("left");
    expect(swipeOf(track([100, 300], [180, 295, 80], [220, 290, 160]), WIDTH)).toBe("right");
  });

  test("too short a move is not one", () => {
    expect(swipeOf(track([200, 300], [200 - SWIPE.distance + 1, 300, 100]), WIDTH)).toBeNull();
    expect(swipeOf(track([200, 300], [200 - SWIPE.distance, 300, 100]), WIDTH)).toBe("left");
  });

  test("a scroll is not one, nor a move that went up or down on its way", () => {
    expect(swipeOf(track([200, 300], [120, 200, 150]), WIDTH)).toBeNull();
    // Ends level with where it started, but went far down in between.
    expect(swipeOf(track([300, 300], [250, 380, 100], [150, 300, 200]), WIDTH)).toBeNull();
  });

  test("a slow move (a long press dragging a selection) is not one", () => {
    expect(swipeOf(track([300, 300], [150, 300, SWIPE.duration + 1]), WIDTH)).toBeNull();
  });

  test("a touch starting at a side of the screen is left to the system's back gesture", () => {
    expect(swipeOf(track([SWIPE.edge - 1, 300], [200, 300, 100]), WIDTH)).toBeNull();
    expect(swipeOf(track([WIDTH - SWIPE.edge + 1, 300], [100, 300, 100]), WIDTH)).toBeNull();
    expect(swipeOf(track([SWIPE.edge, 300], [200, 300, 100]), WIDTH)).toBe("right");
  });

  test("a touch that did not move is not one", () => {
    expect(swipeOf(track([200, 300]), WIDTH)).toBeNull();
  });
});
