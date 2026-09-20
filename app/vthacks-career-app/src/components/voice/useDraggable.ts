'use client';

/**
 * useDraggable — a floating panel that moves with the mouse OR the arrow keys.
 *
 * THE KEYBOARD PATH IS NOT A COURTESY. A mouse-only drag is exactly the kind of
 * thing hard rule 6 exists to prevent: it makes a control that exists on screen
 * unreachable for anyone not using a pointer. So the handle is a real <button>,
 * focusable in normal tab order, and the arrow keys move it — Shift for a coarse
 * step. Both input methods drive the same setPosition, so there is no chance of one
 * working and the other silently rotting.
 *
 * Position is persisted to localStorage and clamped to the viewport on read, because
 * a window that shrinks between visits would otherwise restore the widget off-screen
 * where neither the mouse nor the keyboard can reach it.
 *
 * TWO STRUCTURAL CHOICES THAT LOOK ODD AND ARE NOT:
 *
 * 1. The initial position is computed in a CALLBACK REF, not in an effect and not in
 *    a useState initialiser. It cannot be a useState initialiser because reading
 *    window.innerWidth or localStorage during render gives the server and the client
 *    different HTML and React 19 throws the tree away over it. It is not an effect
 *    because a setState in an effect body causes the cascading re-render that
 *    react-hooks/set-state-in-effect exists to stop — and because the callback ref is
 *    the exact moment the element exists and can be measured, which is what we need.
 *
 * 2. The element is attached with `attach`, a function, rather than by handing a ref
 *    object back to the caller. A ref that crosses a component boundary and is then
 *    read during the consumer's render is what react-hooks/refs flags; keeping the
 *    node private to this hook means only event handlers ever touch it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type Point = { x: number; y: number };

const STORAGE_KEY = 'hirewire.voice.widget-position';

/** One arrow press. Big enough to be useful, small enough to be precise. */
const STEP = 16;
/** Shift + arrow, for crossing the screen without forty keystrokes. */
const COARSE_STEP = 96;

/** Never let the widget leave less than this much of itself on screen. */
const MARGIN = 8;

type Size = { width: number; height: number };

function clamp(point: Point, size: Size): Point {
  const maxX = Math.max(MARGIN, window.innerWidth - size.width - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - size.height - MARGIN);
  return {
    x: Math.min(Math.max(point.x, MARGIN), maxX),
    y: Math.min(Math.max(point.y, MARGIN), maxY),
  };
}

function corner(size: Size): Point {
  return { x: window.innerWidth - size.width - 28, y: window.innerHeight - size.height - 28 };
}

function stored(): Point | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Point).x === 'number' &&
      typeof (parsed as Point).y === 'number'
    ) {
      return parsed as Point;
    }
  } catch {
    // A corrupt or blocked localStorage is not a reason to have no widget.
  }
  return null;
}

export type Draggable = {
  /** Spread onto the floating element, along with `attach` as its ref. */
  style: { left: number; top: number } | undefined;
  attach: (node: HTMLDivElement | null) => void;
  /** Spread onto the drag handle, which must be a <button>. */
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  /** Announced politely after a move settles, for screen-reader users. */
  announcement: string;
  isDragging: boolean;
  reset: () => void;
};

export function useDraggable(): Draggable {
  // undefined until the element has mounted and been measured. Rendering without a
  // position would place the widget top-left for one frame and then jump it.
  const [position, setPosition] = useState<Point | undefined>(undefined);
  const [isDragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const node = useRef<HTMLDivElement | null>(null);
  const grab = useRef<Point>({ x: 0, y: 0 });

  const measure = useCallback((): Size => {
    const rect = node.current?.getBoundingClientRect();
    return { width: rect?.width ?? 280, height: rect?.height ?? 190 };
  }, []);

  const attach = useCallback((element: HTMLDivElement | null) => {
    node.current = element;
    if (!element) return;
    const size = element.getBoundingClientRect();
    // Only ever sets the FIRST position: a re-attach (a re-render that swaps the
    // DOM node) must not throw away where the user put it.
    setPosition((current) => current ?? clamp(stored() ?? corner(size), size));
  }, []);

  // Persist. No setState, so this is exactly what an effect is for: pushing React
  // state out to an external system.
  useEffect(() => {
    if (!position) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
    } catch {
      // Private-browsing quota failures are not worth breaking the UI over.
    }
  }, [position]);

  // Keep the widget on screen when the window is resized. setState happens in the
  // subscription callback, not the effect body.
  useEffect(() => {
    const onResize = () => setPosition((current) => (current ? clamp(current, measure()) : current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measure]);

  // One announcement per burst of movement, not one per keystroke — holding an
  // arrow key down would otherwise flood a screen reader with coordinates.
  useEffect(() => {
    if (!position) return;
    const timer = window.setTimeout(() => {
      setAnnouncement(
        `Voice control moved to ${Math.round(position.x)} pixels from the left, ${Math.round(position.y)} from the top.`,
      );
    }, 600);
    return () => window.clearTimeout(timer);
  }, [position]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // Left button only. A right-click on the handle should open the context menu.
      if (event.button !== 0) return;
      const rect = node.current?.getBoundingClientRect();
      if (!rect) return;

      grab.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      setDragging(true);

      // Pointer capture on the handle rather than document listeners: it survives the
      // pointer leaving the element, and releases automatically if the browser steals
      // the gesture (a scroll, an alt-tab), so there is no way to get stuck dragging.
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);

      const onMove = (move: PointerEvent) => {
        setPosition(clamp({ x: move.clientX - grab.current.x, y: move.clientY - grab.current.y }, measure()));
      };
      const onUp = () => {
        setDragging(false);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [measure],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? COARSE_STEP : STEP;
      const moves: Record<string, Point> = {
        ArrowLeft: { x: -step, y: 0 },
        ArrowRight: { x: step, y: 0 },
        ArrowUp: { x: 0, y: -step },
        ArrowDown: { x: 0, y: step },
      };
      const delta = moves[event.key];
      if (!delta) return;

      // Arrow keys scroll the page by default, which would move the background
      // instead of the widget and look to the user like nothing happened.
      event.preventDefault();
      setPosition((current) => (current ? clamp({ x: current.x + delta.x, y: current.y + delta.y }, measure()) : current));
    },
    [measure],
  );

  const reset = useCallback(() => {
    const size = measure();
    setPosition(clamp(corner(size), size));
  }, [measure]);

  return {
    style: position ? { left: position.x, top: position.y } : undefined,
    attach,
    onPointerDown,
    onKeyDown,
    announcement,
    isDragging,
    reset,
  };
}
