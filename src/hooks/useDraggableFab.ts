import {
  FAB_POSITION_RESET_EVENT,
  fabPositionStorageKey,
  loadStoredFabOffset,
} from "@/lib/fab-position";
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const DRAG_THRESHOLD_PX = 4;
const VIEWPORT_MARGIN_PX = 5;
const LONG_PRESS_RESET_MS = 2000;

function clampRectToViewport(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  const maxLeft = Math.max(
    VIEWPORT_MARGIN_PX,
    window.innerWidth - rect.width - VIEWPORT_MARGIN_PX,
  );
  const maxTop = Math.max(
    VIEWPORT_MARGIN_PX,
    window.innerHeight - rect.height - VIEWPORT_MARGIN_PX,
  );
  return {
    left: Math.min(Math.max(rect.left, VIEWPORT_MARGIN_PX), maxLeft),
    top: Math.min(Math.max(rect.top, VIEWPORT_MARGIN_PX), maxTop),
  };
}

export function useDraggableFab(userId: string | null) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [longPressProgress, setLongPressProgress] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    rectLeft: number;
    rectTop: number;
    width: number;
    height: number;
    pointerId: number;
  } | null>(null);
  const draggedRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressRafRef = useRef<number | null>(null);
  const longPressStartRef = useRef(0);
  const longPressTriggeredRef = useRef(false);

  // Load (and clamp, in case the window has shrunk since it was saved)
  // this user's stored offset whenever the user id becomes known/changes.
  useEffect(() => {
    if (draggedRef.current) return;
    const stored = loadStoredFabOffset(fabPositionStorageKey(userId));
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) {
      setOffset(stored);
      return;
    }
    const clamped = clampRectToViewport({
      left: rect.left + stored.x,
      top: rect.top + stored.y,
      width: rect.width,
      height: rect.height,
    });
    setOffset({ x: clamped.left - rect.left, y: clamped.top - rect.top });
  }, [userId]);

  useEffect(() => {
    const handleReset = () => setOffset({ x: 0, y: 0 });
    window.addEventListener(FAB_POSITION_RESET_EVENT, handleReset);
    return () =>
      window.removeEventListener(FAB_POSITION_RESET_EVENT, handleReset);
  }, []);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (longPressRafRef.current) {
      cancelAnimationFrame(longPressRafRef.current);
      longPressRafRef.current = null;
    }
    setLongPressProgress(0);
  }, []);

  const resetPosition = useCallback(() => {
    setOffset({ x: 0, y: 0 });
    try {
      localStorage.removeItem(fabPositionStorageKey(userId));
    } catch {
      // ignore
    }
  }, [userId]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return; // left mouse / touch / pen only
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: offset.x,
        originY: offset.y,
        rectLeft: rect.left,
        rectTop: rect.top,
        width: rect.width,
        height: rect.height,
        pointerId: e.pointerId,
      };

      longPressTriggeredRef.current = false;
      longPressStartRef.current = performance.now();
      const tick = () => {
        const elapsed = performance.now() - longPressStartRef.current;
        setLongPressProgress(Math.min(1, elapsed / LONG_PRESS_RESET_MS));
        longPressRafRef.current = requestAnimationFrame(tick);
      };
      longPressRafRef.current = requestAnimationFrame(tick);
      longPressTimerRef.current = setTimeout(() => {
        longPressTriggeredRef.current = true;
        clearLongPress();
        resetPosition();
      }, LONG_PRESS_RESET_MS);
    },
    [offset, clearLongPress, resetPosition],
  );

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!draggedRef.current) {
        draggedRef.current = true;
        setIsDragging(true);
        clearLongPress(); // dragging supersedes the press-and-hold reset
      }
      const clamped = clampRectToViewport({
        left: drag.rectLeft + dx,
        top: drag.rectTop + dy,
        width: drag.width,
        height: drag.height,
      });
      setOffset({
        x: drag.originX + (clamped.left - drag.rectLeft),
        y: drag.originY + (clamped.top - drag.rectTop),
      });
    };

    const handleUp = () => {
      dragRef.current = null;
      setIsDragging(false);
      clearLongPress();
      if (longPressTriggeredRef.current) {
        setTimeout(() => {
          longPressTriggeredRef.current = false;
        }, 0);
      }
      if (draggedRef.current) {
        setOffset((current) => {
          try {
            localStorage.setItem(
              fabPositionStorageKey(userId),
              JSON.stringify(current),
            );
          } catch {
            // ignore storage errors (private mode, quota, etc.)
          }
          return current;
        });
        setTimeout(() => {
          draggedRef.current = false;
        }, 0);
      }
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [clearLongPress, userId]);

  useEffect(() => {
    const reclamp = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clamped = clampRectToViewport(rect);
      const dLeft = clamped.left - rect.left;
      const dTop = clamped.top - rect.top;
      if (dLeft === 0 && dTop === 0) return;
      setOffset((current) => ({
        x: current.x + dLeft,
        y: current.y + dTop,
      }));
    };

    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, []);

  const onClickCapture = useCallback((e: SyntheticEvent) => {
    if (draggedRef.current || longPressTriggeredRef.current) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  return {
    offset,
    isDragging,
    longPressProgress,
    containerRef,
    onPointerDown,
    onClickCapture,
    resetPosition,
  };
}
